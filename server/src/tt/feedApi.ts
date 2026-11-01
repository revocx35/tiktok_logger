import type { FeedComment, FeedItem, FeedReplyPage, ProfileTab, ProfileVideoPage, TtProfile } from '../../../shared/api.js';
import type { AppContext, TtFeed, TtSocial } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { FeedCatalog, type CatalogItem } from './feed.js';
import { validUsername } from './pageActions.js';
import { FeedMedia, refOf, type Fetched, type Downloader } from './feedMedia.js';
import { WebApiError, type WebApi } from './web/api.js';

/**
 * The For You feed and its comments through TikTok's own web API, called from the messages tab (see web/api.ts).
 *
 * No feed page is opened, scrolled or clicked: batches of videos come from `/api/recommend/item_list/`, the list order is
 * the feed's order, a swipe is an index move in memory, and likes/comments are the same requests TikTok's page sends.
 * Nothing of the feed is stored; posting a comment adds one audit line.
 */

const PRELOAD_AHEAD = 3;
const GOTO_ITEMS = 5;
const AHEAD_MIN = 6;
const origin = 'https://www.tiktok.com';

interface RawComment {
  cid?: string;
  text?: string;
  digg_count?: number;
  user_digged?: number;
  reply_comment_total?: number;
  user?: { unique_id?: string; nickname?: string };
  reply_comment?: RawComment[] | null;
}

interface RawUser {
  id?: unknown;
  uniqueId?: unknown;
  nickname?: unknown;
  avatarMedium?: unknown;
  avatarThumb?: unknown;
  signature?: unknown;
  secUid?: unknown;
  verified?: unknown;
  privateAccount?: unknown;
  relation?: unknown;
  bioLink?: { link?: unknown } | null;
}
interface RawStats { followerCount?: unknown; followingCount?: unknown; heartCount?: unknown; heart?: unknown; videoCount?: unknown }

/**
 * What TikTok only accepts from its own controls (ticket guard): the feed window opens the video from its author's
 * profile, or the profile itself, and clicks (see `pageActions.ts`).
 */
export interface PageClicks {
  like(id: string, author: string | null, want: boolean): Promise<{ liked: boolean }>;
  repost(id: string, author: string, want: boolean): Promise<{ reposted: boolean }>;
  follow(username: string, want: boolean): Promise<{ following: boolean }>;
}

/** The list behind each profile tab (all four answer `{itemList, cursor, hasMore}`; measured live 2026-10-31). */
const TAB_PATH: Record<ProfileTab, string> = {
  videos: '/api/post/item_list/',
  reposts: '/api/repost/item_list/',
  liked: '/api/favorite/item_list/',
  favorites: '/api/user/collect/item_list/',
};
/** TikTok's `relation` lags a fresh follow by minutes: what the app itself just did wins for this long. */
const FOLLOW_MEMORY_MS = 15 * 60_000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export class ApiFeed implements TtFeed, TtSocial {
  private readonly media = new FeedMedia(PRELOAD_AHEAD, (reason) => {
    const now = Date.now();
    if (now - this.lastWarn < 10_000) return;
    this.lastWarn = now;
    this.ctx.log.warn({ reason }, 'feed media download failed');
  });
  private lastWarn = 0;
  private lastId: string | null = null;
  private loading: Promise<void> | null = null;
  private lastLoadAt = 0;
  /** Items from profile lists (not the feed's order): the /api/feed/:id/* routes work on them too. */
  private readonly seen = new FeedCatalog();
  /** username → secUid (the video lists need it) and the owner's own identity, from the page. */
  private readonly secUids = new Map<string, string>();
  private me: { username: string; secUid: string } | null = null;
  private readonly followMemory = new Map<string, { following: boolean; until: number }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly api: () => WebApi | null,
    private readonly downloader: () => Downloader | null,
    /** Clicks TikTok's own controls in the feed window (like, repost, follow). */
    private readonly clicks: PageClicks,
    readonly catalog: FeedCatalog = new FeedCatalog(),
  ) {}

  private web(): WebApi {
    const a = this.api();
    if (!a) throw Errors.unavailable('TikTok is not connected. Log in on the TikTok screen first.');
    return a;
  }

  /** Forgets the position (logout, reconnect). */
  reset(): void {
    this.lastId = null;
    this.media.clear();
    this.me = null;
    this.secUids.clear();
    this.followMemory.clear();
  }

  /** A video the app has seen, from the feed or a profile list. */
  private find(id: string): CatalogItem | null {
    return this.catalog.byIdLookup(id) ?? this.seen.byIdLookup(id);
  }

  /* ------------------------------------------------------------------ list */

  /** Asks TikTok for the next batch of the For You feed (single flight; the batch lands in the catalog). */
  private loadMore(): Promise<void> {
    if (this.loading) return this.loading;
    if (Date.now() - this.lastLoadAt < 1500) return Promise.resolve();
    this.lastLoadAt = Date.now();
    const api = this.web();
    this.loading = (async () => {
      const r = await api.call('POST', '/api/recommend/item_list/', {
        count: '6',
        coverFormat: '2',
        cpu_core_number: '4',
        dark_mode: 'false',
        device_type: 'web_h264',
        enable_cache: 'false',
        from_page: 'fyp',
        isNonPersonalized: 'false',
        is_new_user: 'false',
        itemID: '',
        language: 'en',
        launch_mode: 'direct',
        pullType: '1',
        showAboutThisAd: 'true',
        showAds: 'false',
        video_encoding: 'mp4',
        watchLiveLastTime: '',
        window_height: '712',
        window_width: '1280',
      });
      if (r.status !== 200 || !r.text) throw new AppError(502, 'feed_load', 'TikTok did not give a new batch of videos.');
      this.catalog.ingest(r.text);
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** The video the UI is on; the first call starts with a fresh batch. */
  private async anchor(): Promise<string | null> {
    if (this.lastId && this.catalog.indexOf(this.lastId) >= 0) return this.lastId;
    const before = this.catalog.size;
    await this.loadMore();
    this.lastLoadAt = 0;
    // The first video of the batch just loaded is where a new session starts.
    const fresh = this.catalog.afterIndex(Math.max(-1, before - 1), 12).find((c) => c.playAddr);
    this.lastId = fresh?.id ?? null;
    return this.lastId;
  }

  private itemsFrom(id: string, count: number): FeedItem[] {
    const first = this.catalog.byIdLookup(id);
    if (!first) return [];
    const out = [this.toItem(first)];
    // Photo posts and the like have no video to play: the swiper only gets videos.
    for (const c of this.catalog.after(id, count + 6)) {
      if (out.length >= count) break;
      if (c.playAddr) out.push(this.toItem(c));
    }
    return out;
  }

  private toItem(c: CatalogItem): FeedItem {
    return {
      id: c.id,
      url: `${origin}/@${c.author ?? ''}/video/${c.id}`,
      author: { username: c.author, name: c.authorName, avatar: c.avatar ? this.media.ref(c.avatar) : null, following: this.followingOf(c.author, c.authorRelation ?? null) },
      caption: c.desc,
      music: c.music,
      stats: { likes: c.likes, comments: c.comments, shares: c.shares, plays: c.plays },
      liked: c.liked ?? false,
      reposted: c.reposted ?? null,
      canRepost: c.canRepost !== false,
      video:
        c.playAddr || c.cover
          ? {
              src: c.playAddr ? this.media.ref(c.playAddr) : null,
              poster: c.cover ? this.media.ref(c.cover) : null,
              muted: true,
              playing: false,
              captions: (c.subtitles ?? []).map((t) => ({ lang: t.lang, src: this.media.ref(t.url, 'text/vtt') })),
              download: c.playAddr ? `/api/feed/${c.id}/download` : null,
            }
          : null,
    };
  }

  /** The follow state: what the app just did, else TikTok's `relation` (1 following, 2 friends). */
  private followingOf(username: string | null, relation: number | null): boolean | null {
    if (!username) return null;
    const m = this.followMemory.get(username.toLowerCase());
    if (m && m.until > Date.now()) return m.following;
    return relation === null ? null : relation === 1 || relation === 2;
  }

  private after(id: string): void {
    this.lastId = id;
    this.warm(id);
    if (this.catalog.after(id, AHEAD_MIN).length < AHEAD_MIN) void this.loadMore().catch(() => undefined);
  }

  private warm(id: string): void {
    const dl = this.downloader();
    if (!dl) return;
    let n = 0;
    for (const c of this.catalog.after(id, PRELOAD_AHEAD + 2)) {
      if (n >= PRELOAD_AHEAD) break;
      if (!c.playAddr || this.media.cached(refOf(c.playAddr))) continue;
      this.media.ref(c.playAddr);
      this.media.prefetch(c.playAddr, dl);
      if (c.cover) this.media.ref(c.cover);
      n++;
    }
  }

  /* ------------------------------------------------------------- TtFeed API */

  async current(): Promise<FeedItem | null> {
    const id = await this.anchor();
    if (!id) return null;
    this.after(id);
    return this.itemsFrom(id, 1)[0] ?? null;
  }

  async window(limit = 3): Promise<{ items: FeedItem[]; current: string | null }> {
    const id = await this.anchor();
    if (!id) return { items: [], current: null };
    // A short list is topped up before answering, so the client always has something to swipe to.
    if (this.catalog.after(id, limit).length < limit) await this.loadMore().catch(() => undefined);
    this.after(id);
    return { items: this.itemsFrom(id, limit), current: id };
  }

  async goto(id: string): Promise<{ items: FeedItem[]; current: string | null }> {
    if (!this.catalog.byIdLookup(id)) throw new AppError(409, 'feed_moved', 'That video is not in the feed any more. Reload the feed.');
    this.after(id);
    return { items: this.itemsFrom(id, GOTO_ITEMS), current: id };
  }

  async step(dir: 'next' | 'prev'): Promise<FeedItem> {
    const id = await this.anchor();
    if (!id) throw new AppError(502, 'feed_step', 'The feed is empty.');
    const at = this.catalog.indexOf(id);
    const target = dir === 'next' ? this.catalog.after(id, 8).find((c) => c.playAddr) : this.catalog.afterIndex(at - 2, 1)[0];
    if (!target || target.id === id) {
      if (dir === 'prev') throw new AppError(502, 'feed_step', 'This is the first video of the session.');
      await this.loadMore();
      const again = this.catalog.after(id, 1)[0];
      if (!again) throw new AppError(504, 'feed_timeout', 'TikTok did not give a next video.');
      this.after(again.id);
      return this.toItem(again);
    }
    this.after(target.id);
    return this.toItem(target);
  }

  /**
   * Shares the video into a chat as a card.
   *
   * The card needs the post id **and** its author's id/secUid, which is why this lives here: the item list carries them
   * (`author.id`, `author.secUid`) and a plain text link does not render as a video on the other side.
   */
  async share(id: string, chatId: string): Promise<{ id: string }> {
    const item = this.find(id);
    if (!item) throw Errors.conflict('That video is not in the feed any more. Swipe to it again.');
    if (!item.authorId) throw new AppError(409, 'share', 'TikTok did not say who posted that video, so it cannot be shared as a card.');
    const sent = await this.ctx.tt.sender.sendShare(chatId, {
      itemId: item.id,
      uid: item.authorId,
      ...(item.authorSecUid ? { secUid: item.authorSecUid } : {}),
      ...(item.authorName ? { name: item.authorName } : {}),
      ...(item.desc ? { title: item.desc.slice(0, 120) } : {}),
      ...(item.cover ? { cover: { urls: [item.cover] } } : {}),
      // The card's thumb is the **author's avatar**, not the video's cover: TikTok's own DM share dialog sends the
      // avatar there, and a body whose thumb is the cover is accepted with status 0 and then never stored (verified
      // live 2026-10-23 by sending both bodies into a chat and reading the conversation back).
      ...((item.avatar ?? item.cover) ? { thumb: { urls: [item.avatar ?? item.cover] as string[] } } : {}),
      ...(item.videoWidth ? { width: item.videoWidth } : {}),
      ...(item.videoHeight ? { height: item.videoHeight } : {}),
    });
    return { id: sent.id ?? '' };
  }

  /**
   * Like/unlike through TikTok's own control, never through the web API.
   *
   * `POST /api/commit/item/digg/` answers **403 `Web SDK blocked by Argus TLB Plugin`**: TikTok's SDK stamps
   * `tt-ticket-guard-*` headers onto the requests it makes itself, and a plain `fetch` from the page does not get them
   * (measured live 2026-10-23 — every parameter variant answered 403, while one click on the page's like control
   * answered 200 and moved the count). So the work is delegated to the page: the video is put on screen and its like
   * button is clicked, and what the page then shows is what is reported back.
   */
  async like(id: string, want: boolean): Promise<{ liked: boolean }> {
    const c = this.find(id);
    if (c && c.liked === want) return { liked: want };
    let seen: { liked: boolean };
    try {
      seen = await this.clicks.like(id, c?.author ?? null, want);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'like', 'TikTok did not answer the like.');
    }
    this.catalog.markLiked(id, seen.liked);
    this.seen.markLiked(id, seen.liked);
    return seen;
  }

  async comments(id: string): Promise<FeedComment[]> {
    try {
      const j = await this.web().json<{ comments?: RawComment[] | null }>('GET', '/api/comment/list/', { aweme_id: id, count: '20', cursor: '0', from_page: 'video' });
      return (j.comments ?? []).slice(0, 30).map(toComment);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'comments', e instanceof WebApiError ? `TikTok did not give the comments (${e.message}).` : "TikTok's comments did not load. Try again.");
    }
  }

  async comment(id: string, text: string): Promise<FeedComment[]> {
    const body = text.trim();
    if (!body) throw Errors.validation('The comment is empty.');
    if (body.length > 150) throw Errors.validation('TikTok comments are limited to 150 characters.');
    let posted: FeedComment | null = null;
    try {
      const j = await this.web().json<{ comment?: RawComment }>('POST', '/api/comment/publish/', { aweme_id: id, from_page: 'video', text: body, text_extra: '[]' });
      posted = j.comment ? toComment(j.comment) : null;
    } catch (e) {
      throw new AppError(502, 'comment', e instanceof WebApiError ? `TikTok did not accept the comment (${e.message}).` : 'TikTok did not answer; the comment may or may not have been posted.');
    }
    this.ctx.repo.audit('feed_comment', null, 'comment');
    const list = await this.comments(id).catch(() => [] as FeedComment[]);
    return posted && !list.some((c) => c.id === posted!.id) ? [posted, ...list] : list;
  }

  async closeComments(): Promise<void> {
    /* there is no panel */
  }

  /* --------------------------------------------------------------- social */

  async profile(username: string | 'me'): Promise<TtProfile> {
    const me = await this.identity();
    const name = username === 'me' ? me?.username : username;
    if (!name) throw Errors.unavailable('TikTok did not say which account is logged in. Reload the TikTok screen.');
    if (!validUsername(name)) throw Errors.validation('That is not a TikTok username.');
    let j: { userInfo?: { user?: RawUser; stats?: RawStats } };
    try {
      j = await this.web().json('GET', '/api/user/detail/', { uniqueId: name, secUid: '' });
    } catch (e) {
      throw this.readError(e, 'profile', 'TikTok did not give that profile');
    }
    const u = j.userInfo?.user;
    const id = str(u?.id);
    const uname = str(u?.uniqueId);
    if (!u || !id || !uname) throw Errors.notFound('Profile');
    const sec = str(u.secUid);
    if (sec) this.secUids.set(uname.toLowerCase(), sec);
    const isMe = !!me && me.username.toLowerCase() === uname.toLowerCase();
    const relation = num(u.relation);
    const st = j.userInfo?.stats ?? {};
    const priv = u.privateAccount === true;
    const following = isMe ? null : this.followingOf(uname, relation);
    const avatar = str(u.avatarMedium) ?? str(u.avatarThumb);
    const link = str(u.bioLink?.link);
    return {
      id,
      username: uname,
      name: str(u.nickname),
      avatar: avatar ? this.media.ref(avatar) : null,
      bio: str(u.signature),
      link: link && /^https?:\/\//i.test(link) ? link : link ? `https://${link}` : null,
      verified: u.verified === true,
      private: priv,
      me: isMe,
      following,
      friends: !isMe && relation === 2 && following !== false,
      stats: { followers: num(st.followerCount), following: num(st.followingCount), likes: num(st.heartCount) ?? num(st.heart), videos: num(st.videoCount) },
      tabs: isMe ? ['videos', 'reposts', 'liked', 'favorites'] : priv && !following ? [] : ['videos', 'reposts'],
      url: `${origin}/@${uname}`,
    };
  }

  async profileVideos(username: string | 'me', tab: ProfileTab, cursor: string | null): Promise<ProfileVideoPage> {
    const me = await this.identity();
    const name = username === 'me' ? me?.username : username;
    if (!name) throw Errors.unavailable('TikTok did not say which account is logged in. Reload the TikTok screen.');
    const isMe = !!me && me.username.toLowerCase() === name.toLowerCase();
    if (!isMe && (tab === 'liked' || tab === 'favorites')) throw Errors.forbidden("TikTok only shows those lists on the owner's own profile.");
    let sec = isMe ? me!.secUid : this.secUids.get(name.toLowerCase());
    if (!sec) {
      await this.profile(name);
      sec = this.secUids.get(name.toLowerCase());
    }
    if (!sec) throw Errors.notFound('Profile');
    if (cursor !== null && !/^\d{1,20}$/.test(cursor)) throw Errors.validation('Bad cursor.');
    let j: { itemList?: unknown[]; cursor?: unknown; hasMore?: unknown };
    try {
      j = await this.web().json('GET', TAB_PATH[tab], { secUid: sec, count: '16', cursor: cursor ?? '0', coverFormat: '2' });
    } catch (e) {
      throw this.readError(e, 'profile_videos', 'TikTok did not give that list');
    }
    const list = Array.isArray(j.itemList) ? j.itemList : [];
    this.seen.ingest(JSON.stringify({ itemList: list }));
    const items: FeedItem[] = [];
    for (const raw of list) {
      const id = String((raw as { id?: unknown })?.id ?? '');
      const c = this.seen.byIdLookup(id);
      if (!c) continue;
      if (isMe && tab === 'reposts') this.seen.markReposted(id, true);
      if (isMe && tab === 'liked' && c.liked === null) c.liked = true;
      items.push(this.toItem(c));
    }
    const next = typeof j.cursor === 'string' || typeof j.cursor === 'number' ? String(j.cursor) : null;
    const more = j.hasMore === true && !!next && next !== (cursor ?? '0');
    return { items, cursor: more ? next : null, more };
  }

  async follow(username: string, want: boolean): Promise<{ following: boolean }> {
    if (!validUsername(username)) throw Errors.validation('That is not a TikTok username.');
    const me = await this.identity().catch(() => null);
    if (me && me.username.toLowerCase() === username.toLowerCase()) throw Errors.validation('You cannot follow yourself.');
    let r: { following: boolean };
    try {
      r = await this.clicks.follow(username, want);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'follow', 'TikTok did not answer; check on the TikTok screen whether it worked.');
    }
    this.followMemory.set(username.toLowerCase(), { following: r.following, until: Date.now() + FOLLOW_MEMORY_MS });
    this.ctx.repo.audit(r.following ? 'tt_follow' : 'tt_unfollow', null, 'profile');
    return r;
  }

  async repost(id: string, want: boolean): Promise<{ reposted: boolean }> {
    const c = this.find(id);
    if (!c?.author) throw Errors.conflict('That video is not loaded any more. Open it again.');
    if (want && c.canRepost === false) throw new AppError(409, 'no_repost', 'The author turned reposts off for this video.');
    if (c.reposted === want) return { reposted: want };
    let r: { reposted: boolean };
    try {
      r = await this.clicks.repost(id, c.author, want);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'repost', 'TikTok did not answer; check on the TikTok screen whether it worked.');
    }
    this.catalog.markReposted(id, r.reposted);
    this.seen.markReposted(id, r.reposted);
    this.ctx.repo.audit(r.reposted ? 'tt_repost' : 'tt_unrepost', null, 'video');
    return r;
  }

  async replies(id: string, commentId: string, cursor: string | null): Promise<FeedReplyPage> {
    if (cursor !== null && !/^\d{1,20}$/.test(cursor)) throw Errors.validation('Bad cursor.');
    let j: { comments?: RawComment[] | null; cursor?: unknown; has_more?: unknown };
    try {
      j = await this.web().json('GET', '/api/comment/list/reply/', { comment_id: commentId, item_id: id, count: '20', cursor: cursor ?? '0' });
    } catch (e) {
      throw this.readError(e, 'replies', 'TikTok did not give the replies');
    }
    const next = typeof j.cursor === 'number' || typeof j.cursor === 'string' ? String(j.cursor) : null;
    const more = (j.has_more === 1 || j.has_more === true) && !!next;
    return { comments: (j.comments ?? []).slice(0, 50).map(toComment), cursor: more ? next : null, more };
  }

  async reply(id: string, commentId: string, text: string, toReply: string | null): Promise<FeedReplyPage> {
    const body = text.trim();
    if (!body) throw Errors.validation('The reply is empty.');
    if (body.length > 150) throw Errors.validation('TikTok comments are limited to 150 characters.');
    let posted: FeedComment | null = null;
    try {
      // The fields TikTok's own comment box sends (webapp bundle, 2026-10-31): reply_id = the thread's top comment,
      // reply_to_reply_id = the reply being answered inside it ("0" for the top comment itself).
      const j = await this.web().json<{ comment?: RawComment }>('POST', '/api/comment/publish/', {
        aweme_id: id,
        from_page: 'video',
        text: body,
        text_extra: '[]',
        reply_id: commentId,
        reply_to_reply_id: toReply ?? '0',
      });
      posted = j.comment ? toComment(j.comment) : null;
    } catch (e) {
      throw new AppError(502, 'comment', e instanceof WebApiError ? `TikTok did not accept the reply (${e.message}).` : 'TikTok did not answer; the reply may or may not have been posted.');
    }
    this.ctx.repo.audit('feed_comment', null, 'reply');
    const page = await this.replies(id, commentId, null).catch(() => ({ comments: [] as FeedComment[], cursor: null, more: false }));
    return posted && !page.comments.some((c) => c.id === posted!.id) ? { ...page, comments: [...page.comments, posted] } : page;
  }

  /** Comment likes are not behind the ticket guard: `/api/comment/digg/` with digg_type 1 (like) / 2 (unlike), live 2026-10-31. */
  async likeComment(id: string, commentId: string, want: boolean): Promise<{ liked: boolean }> {
    try {
      await this.web().json('POST', '/api/comment/digg/', { aweme_id: id, cid: commentId, digg_type: want ? '1' : '2' });
    } catch (e) {
      throw new AppError(502, 'comment_like', e instanceof WebApiError ? `TikTok did not accept that (${e.message}).` : 'TikTok did not answer the like.');
    }
    return { liked: want };
  }

  async download(id: string): Promise<{ mime: string; data: Buffer; filename: string }> {
    const c = this.find(id);
    if (!c?.playAddr) throw Errors.conflict('That video is not loaded any more. Open it again.');
    const dl = this.downloader();
    if (!dl) throw Errors.unavailable('The TikTok connection is not open.');
    this.media.ref(c.playAddr);
    const f = await this.media.get(refOf(c.playAddr), dl);
    if (!f) throw new AppError(502, 'download', 'TikTok did not give the video.');
    const who = (c.author ?? 'video').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'video';
    return { mime: f.mime, data: f.data, filename: `tiktok-${who}-${c.id}.${f.mime === 'video/webm' ? 'webm' : 'mp4'}` };
  }

  /** The logged-in account (username + secUid), from the messages page's own data; cached until a reset. */
  private async identity(): Promise<{ username: string; secUid: string } | null> {
    if (this.me) return this.me;
    const id = await this.web().identity().catch(() => null);
    if (id) this.me = { username: id.uniqueId, secUid: id.secUid };
    return this.me;
  }

  private readError(e: unknown, code: string, what: string): AppError {
    if (e instanceof AppError) return e;
    return new AppError(502, code, e instanceof WebApiError ? `${what} (${e.message}).` : `${what}. Try again.`);
  }

  /* ----------------------------------------------------------------- media */

  async mediaOf(ref: string): Promise<Fetched | null> {
    if (!this.media.urlOf(ref)) return null;
    const dl = this.downloader();
    if (!dl) throw Errors.unavailable('The TikTok connection is not open.');
    return this.media.get(ref, dl);
  }

  mediaCached(ref: string): boolean {
    return this.media.cached(ref);
  }

  mediaStats(): { refs: number; cached: number; bytes: number; inflight: number } {
    return this.media.stats();
  }
}

function toComment(c: RawComment): FeedComment {
  return {
    id: String(c.cid ?? ''),
    author: { username: c.user?.unique_id ?? null, name: c.user?.nickname ?? null },
    text: String(c.text ?? ''),
    likes: typeof c.digg_count === 'number' ? c.digg_count : null,
    replies: (c.reply_comment ?? []).slice(0, 10).map(toComment),
    liked: c.user_digged === 1,
    replyCount: typeof c.reply_comment_total === 'number' ? c.reply_comment_total : null,
  };
}
