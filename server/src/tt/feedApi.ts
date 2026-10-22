import type { FeedComment, FeedItem } from '../../../shared/api.js';
import type { AppContext, TtFeed } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { FeedCatalog, type CatalogItem } from './feed.js';
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
  user?: { unique_id?: string; nickname?: string };
  reply_comment?: RawComment[] | null;
}

export class ApiFeed implements TtFeed {
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

  constructor(
    private readonly ctx: AppContext,
    private readonly api: () => WebApi | null,
    private readonly downloader: () => Downloader | null,
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
      author: { username: c.author, name: c.authorName, avatar: c.avatar ? this.media.ref(c.avatar) : null },
      caption: c.desc,
      music: c.music,
      stats: { likes: c.likes, comments: c.comments, shares: c.shares, plays: c.plays },
      liked: c.liked ?? false,
      video: c.playAddr || c.cover ? { src: c.playAddr ? this.media.ref(c.playAddr) : null, poster: c.cover ? this.media.ref(c.cover) : null, muted: true, playing: false } : null,
    };
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
    const item = this.catalog.byIdLookup(id);
    if (!item) throw Errors.conflict('That video is not in the feed any more. Swipe to it again.');
    if (!item.authorId) throw new AppError(409, 'share', 'TikTok did not say who posted that video, so it cannot be shared as a card.');
    const sent = await this.ctx.tt.sender.sendShare(chatId, {
      itemId: item.id,
      uid: item.authorId,
      ...(item.authorSecUid ? { secUid: item.authorSecUid } : {}),
      ...(item.authorName ? { name: item.authorName } : {}),
      ...(item.desc ? { title: item.desc.slice(0, 120) } : {}),
      ...(item.cover ? { cover: { urls: [item.cover] }, thumb: { urls: [item.cover] } } : {}),
      ...(item.videoWidth ? { width: item.videoWidth } : {}),
      ...(item.videoHeight ? { height: item.videoHeight } : {}),
    });
    return { id: sent.id ?? '' };
  }

  async like(id: string, want: boolean): Promise<{ liked: boolean }> {
    const c = this.catalog.byIdLookup(id);
    if (c && c.liked === want) return { liked: want };
    try {
      await this.web().json('POST', '/api/commit/item/digg/', { aweme_id: id, from_page: 'fyp', type: want ? '1' : '0' });
    } catch (e) {
      throw new AppError(502, 'like', e instanceof WebApiError ? `TikTok did not accept the like (${e.message}).` : 'TikTok did not answer the like.');
    }
    this.catalog.markLiked(id, want);
    return { liked: want };
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
  };
}
