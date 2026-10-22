import type { Page } from 'puppeteer';
import type { FeedComment, FeedItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { BrowserDownloader } from './download.js';
import { FeedMedia, refOf, type Fetched } from './feedMedia.js';
import { FeedAgent, mergeFeedSelectors, type RawFeedItem, type RawQueueItem } from './feedAgent.js';

/**
 * TikTok's For You feed, browsed through the server's browser.
 *
 * The feed lives in its own tab (`/foryou`) so the messages tab keeps logging — two tabs in one logged-in session are
 * what a person with two tabs has as well. Videos are streamed through the browser while they play; nothing is
 * downloaded to disk and no video is stored (the feed is not the log).
 */

export interface FeedPageProvider {
  /** The tab for the feed, or null when TikTok is not connected/logged in. */
  feedPage(): Promise<{ page: Page; origin: string } | null>;
}

/** How many videos ahead of the one on screen are downloaded in the background (the apps warm a few as well). */
const PRELOAD_AHEAD = 3;
/** How many videos a swipe's answer carries (the one swiped to and the ones after it). */
const GOTO_ITEMS = 5;
/** TikTok's list is extended when fewer videos than this follow the one on screen. */
const AHEAD_MIN = 6;

/**
 * What the For You page's own JSON knows and the DOM does not: the item id (the DOM has no link to it) and the signed
 * video URL (the page plays through MSE, so `video.src` is a `blob:`). The watcher feeds this from
 * `/api/recommend/item_list/` responses; lookups match the item on screen by author and the start of its caption.
 */
export interface CatalogItem {
  id: string;
  author: string | null;
  desc: string | null;
  playAddr: string | null;
  cover: string | null;
  music: string | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  plays: number | null;
  authorName: string | null;
  avatar: string | null;
  liked: boolean | null;
  /** The author's numeric id and secUid: a shared post card needs both to render on the other side. */
  authorId: string | null;
  authorSecUid: string | null;
  /** The post's pixel size (a share card carries it). */
  videoWidth: number | null;
  videoHeight: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export class FeedCatalog {
  private readonly byId = new Map<string, CatalogItem>();
  private order: string[] = [];

  get size(): number {
    return this.byId.size;
  }

  /** The captured item for a video id (the feed's DOM knows the id, not the URL). */
  byIdLookup(id: string | null): CatalogItem | null {
    return id ? this.byId.get(id) ?? null : null;
  }

  /** The items TikTok queued after [id], in the order it will show them (empty when [id] is unknown). */
  after(id: string | null, n: number): CatalogItem[] {
    const at = id ? this.order.indexOf(id) : -1;
    if (at < 0) return [];
    const out: CatalogItem[] = [];
    for (const k of this.order.slice(at + 1, at + 1 + n)) {
      const it = this.byId.get(k);
      if (it) out.push(it);
    }
    return out;
  }

  /** Remembers a like made through the app, so a later swipe's answer does not bring back the old state. */
  markLiked(id: string, liked: boolean): void {
    const it = this.byId.get(id);
    if (!it || it.liked === liked) return;
    it.liked = liked;
    if (it.likes !== null) it.likes = Math.max(0, it.likes + (liked ? 1 : -1));
  }

  /** The [n] items after position [index] (0-based) in feed order; a negative start counts from the beginning. */
  afterIndex(index: number, n: number): CatalogItem[] {
    const out: CatalogItem[] = [];
    for (const k of this.order.slice(Math.max(0, index + 1), Math.max(0, index + 1) + n)) {
      const it = this.byId.get(k);
      if (it) out.push(it);
    }
    return out;
  }

  /** Position in feed order, or -1. */
  indexOf(id: string | null): number {
    return id ? this.order.indexOf(id) : -1;
  }

  ingest(body: Buffer | string): void {
    let data: unknown;
    try {
      data = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
    } catch {
      return;
    }
    const root = data as { itemList?: unknown; item_list?: unknown; data?: { itemList?: unknown } };
    const list = (root?.itemList ?? root?.item_list ?? root?.data?.itemList) as unknown;
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const it = raw as {
        id?: unknown;
        desc?: unknown;
        author?: { uniqueId?: unknown; nickname?: unknown; avatarThumb?: unknown; avatarMedium?: unknown; id?: unknown; secUid?: unknown };
        digged?: unknown;
        video?: { playAddr?: unknown; play_addr?: unknown; downloadAddr?: unknown; cover?: unknown; originCover?: unknown; width?: unknown; height?: unknown };
        music?: { title?: unknown };
        stats?: { diggCount?: unknown; commentCount?: unknown; shareCount?: unknown; playCount?: unknown };
      };
      const id = String(it?.id ?? '');
      if (!/^\d{6,24}$/.test(id)) continue;
      const v = it.video ?? {};
      const str = (x: unknown): string | null => (typeof x === 'string' && x.length > 8 ? x : null);
      const entry: CatalogItem = {
        id,
        author: typeof it.author?.uniqueId === 'string' ? it.author.uniqueId : null,
        desc: typeof it.desc === 'string' ? it.desc : null,
        playAddr: str(v.playAddr) ?? str(v.play_addr) ?? str(v.downloadAddr),
        cover: str(v.cover) ?? str(v.originCover),
        music: typeof it.music?.title === 'string' ? it.music.title : null,
        likes: num(it.stats?.diggCount),
        comments: num(it.stats?.commentCount),
        shares: num(it.stats?.shareCount),
        plays: num(it.stats?.playCount),
        authorName: typeof it.author?.nickname === 'string' ? it.author.nickname : null,
        authorId: typeof it.author?.id === 'string' ? it.author.id : null,
        authorSecUid: typeof it.author?.secUid === 'string' ? it.author.secUid : null,
        videoWidth: num(v.width) ?? null,
        videoHeight: num(v.height) ?? null,
        avatar: str(it.author?.avatarThumb) ?? str(it.author?.avatarMedium),
        liked: typeof it.digged === 'boolean' ? it.digged : null,
      };
      if (!this.byId.has(id)) this.order.push(id);
      this.byId.set(id, entry);
    }
    while (this.order.length > 300) {
      const old = this.order.shift();
      if (old) this.byId.delete(old);
    }
  }

  /**
   * The item on screen. TikTok truncates the caption in the DOM and loads the list in several batches, so exact pairs
   * are rare: score every candidate (author +3, caption prefix +2, either alone is not enough on its own — a bare
   * author match would pick the author's newest video even when another one is on screen) and take the best, latest.
   */
  find(author: string | null, caption: string | null): CatalogItem | null {
    const a = norm(author);
    const c = norm(caption).replace(/\.\.\.$/, '');
    if (!a && !c) return null;
    let best: CatalogItem | null = null;
    let bestScore = 0;
    let bestHasCaption = false;
    for (const id of this.order) {
      const it = this.byId.get(id);
      if (!it) continue;
      const sameAuthor = !!a && norm(it.author) === a;
      const d = norm(it.desc).replace(/\.\.\.$/, '');
      const sameCaption = !!c && !!d && (d.startsWith(c.slice(0, 40)) || c.startsWith(d.slice(0, 40)));
      const score = (sameAuthor ? 3 : 0) + (sameCaption ? 2 : 0);
      // Equal scores keep the later item: the feed moved on, and the same caption from one author is the same video.
      if (score > bestScore || (score === bestScore && score > 0)) {
        bestScore = score;
        best = it;
        bestHasCaption = sameCaption;
      }
    }
    // Only a caption match is trusted (with or without the author); an author alone would pick their newest video.
    return best && bestHasCaption ? best : null;
  }
}

export class FeedService {
  private agent: FeedAgent | null = null;
  private page: Page | null = null;
  private origin = 'https://www.tiktok.com';
  private downloader: BrowserDownloader | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  // As many parallel downloads as videos we warm, so one page's prefetches are not silently dropped.
  private readonly media = new FeedMedia(PRELOAD_AHEAD, (reason) => {
    const now = Date.now();
    if (now - this.lastMediaWarn < 10_000) return;
    this.lastMediaWarn = now;
    this.ctx.log.warn({ reason }, 'feed media download failed');
  });
  private lastMediaWarn = 0;
  private extending: Promise<void> | null = null;
  private lastExtend = 0;
  private lastId: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly provider: FeedPageProvider,
    private readonly catalog: FeedCatalog | null = null,
  ) {}

  /** True when the feed can be used (TikTok connected and logged in). */
  async available(): Promise<boolean> {
    try {
      return (await this.provider.feedPage()) !== null;
    } catch {
      return false;
    }
  }

  /** Forgets the tab (logout, reconnect, teardown). The page itself belongs to the service that created it. */
  async reset(): Promise<void> {
    this.agent = null;
    this.page = null;
    this.downloader = null;
    this.lastId = null;
    this.media.clear();
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async ensureAgent(): Promise<FeedAgent> {
    if (this.agent && this.page && !this.page.isClosed()) return this.agent;
    const got = await this.provider.feedPage();
    if (!got) throw Errors.unavailable('TikTok is not connected. Log in on the TikTok screen first.');
    this.page = got.page;
    this.origin = got.origin;
    this.downloader = new BrowserDownloader(got.page, true, got.origin === 'https://www.tiktok.com' ? undefined : got.origin);
    await this.downloader.attach().catch(() => undefined);
    this.agent = new FeedAgent(got.page, mergeFeedSelectors(this.ctx.config.ttDomSelectors));
    await this.agent.install();
    await this.waitForItem(15_000);
    return this.agent;
  }

  private async waitForItem(timeoutMs: number): Promise<RawFeedItem> {
    const agent = this.agent;
    if (!agent) throw Errors.unavailable('The feed is not open.');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const item = await agent.current().catch(() => null);
      if (item && (item.id || item.href)) return item;
      await sleep(400);
    }
    throw new AppError(504, 'feed_timeout', "TikTok's feed did not load. Open the TikTok screen and check that the For You page plays.");
  }

  /* ------------------------------------------------------------------ item */

  /** The video in view, with media URLs replaced by short-lived app references. */
  async current(): Promise<FeedItem | null> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const raw = await agent.current().catch(() => null);
      if (!raw) return null;
      this.lastId = raw.id ?? this.lastId;
      const item = this.toItem(raw);
      void agent.hold().catch(() => undefined);
      void this.warmAhead(agent);
      return item;
    });
  }

  /** Moves to the next/previous video and returns it. */
  async step(dir: 'next' | 'prev'): Promise<FeedItem> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const before = (await agent.current().catch(() => null))?.id ?? null;
      const res = await agent.step(dir);
      if (!res.ok) throw new AppError(502, 'feed_step', "TikTok's feed did not move. Try again or use the TikTok screen.");
      // Wait until the visible item really changed (the feed animates).
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleep(300);
        const item = await agent.current().catch(() => null);
        if (!item) continue;
        if (!before || !item.id || item.id !== before) {
          // Give the video element a moment to have a source.
          const withSrc = await this.waitForSrc(agent, 4000);
          this.lastId = withSrc.id ?? this.lastId;
          void agent.hold().catch(() => undefined);
          const item = this.toItem(withSrc);
          void this.warmAhead(agent);
          return item;
        }
      }
      throw new AppError(504, 'feed_timeout', 'TikTok did not show the next video in time.');
    });
  }

  private async waitForSrc(agent: FeedAgent, timeoutMs: number): Promise<RawFeedItem> {
    const deadline = Date.now() + timeoutMs;
    let last: RawFeedItem | null = null;
    while (Date.now() < deadline) {
      const item = await agent.current().catch(() => null);
      if (item) {
        last = item;
        if (item.video?.src) return item;
      }
      await sleep(250);
    }
    if (last) return last;
    throw new AppError(504, 'feed_timeout', 'TikTok did not render the video.');
  }

  private toItem(raw: RawFeedItem): FeedItem {
    // The DOM cannot name the item (no link) and cannot give its video (MSE `blob:` source); the captured item list can.
    // Three sources, best first: the page's own bundled item struct (exact), the captured item list, then the DOM.
    const known = this.catalog?.byIdLookup(raw.id) ?? this.catalog?.find(raw.author.username, raw.caption) ?? null;
    const details = raw.details;
    const id = raw.id ?? known?.id ?? syntheticItemId(raw);
    const domSrc = raw.video?.src && !raw.video.src.startsWith('blob:') ? raw.video.src : null;
    const src = domSrc ?? details?.playAddr ?? known?.playAddr ?? null;
    const posterSrc = raw.video?.poster ?? details?.cover ?? known?.cover ?? null;
    const video = src ? this.media.ref(src) : null;
    const poster = posterSrc ? this.media.ref(posterSrc) : null;
    const avatar = raw.author.avatar ? this.media.ref(raw.author.avatar) : null;
    const pick = (a: number | null, b: number | null | undefined): number | null => (a ?? b ?? null);
    return {
      id,
      url: raw.href ? absolute(raw.href, this.origin) : `${this.origin}/@${raw.author.username ?? ''}/video/${id}`,
      author: { username: raw.author.username, name: raw.author.name, avatar },
      caption: raw.caption ?? details?.desc ?? known?.desc ?? null,
      music: raw.music ?? details?.music ?? known?.music ?? null,
      stats: {
        likes: pick(raw.stats.likes, details?.likes ?? known?.likes),
        comments: pick(raw.stats.comments, details?.comments ?? known?.comments),
        shares: pick(raw.stats.shares, details?.shares ?? known?.shares),
        plays: pick(raw.stats.plays, details?.plays ?? known?.plays),
      },
      liked: raw.liked,
      video: src || poster ? { src: video, poster, muted: raw.video?.muted ?? false, playing: raw.video?.playing ?? false } : null,
    };
  }

  /* ----------------------------------------------------------------- window */

  /**
   * The videos the UI should have on screen: the one in view plus the next few, so the web and the Android client can
   * swipe through them with their own scroller (that is what gives the animation and the momentum) while the remote
   * page stays where the UI is.
   */
  async window(limit = 3): Promise<{ items: FeedItem[]; current: string | null }> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const raw = await agent.current().catch(() => null);
      const items: FeedItem[] = [];
      if (raw) items.push(this.toItem(raw));
      this.addAhead(items, raw?.id ?? null, limit, await agent.queue(limit + 2).catch(() => []));
      void agent.hold().catch(() => undefined);
      this.lastId = raw?.id ?? this.lastId;
      void this.warmAhead(agent);
      void this.extendIfShort(agent, raw?.id ?? null);
      return { items, current: raw?.id ?? null };
    });
  }

  /**
   * Fills [items] with the videos after [anchor]: TikTok's own item list first (it holds the whole batch, in order, with
   * the signed URLs), the page's rendered neighbours only when the list does not know the anchor.
   */
  private addAhead(items: FeedItem[], anchor: string | null, limit: number, queue: RawQueueItem[]): void {
    for (const c of this.catalog?.after(anchor, limit + 2) ?? []) {
      if (items.length >= limit) return;
      if (!items.some((i) => i.id === c.id)) items.push(this.fromCatalog(c));
    }
    if (items.length >= limit) return;
    for (const q of queue) {
      if (items.length >= limit) break;
      if (anchor && q.id === anchor) continue;
      const item = this.fromQueue(q);
      if (item && !items.some((i) => i.id === item.id)) items.push(item);
    }
  }

  /**
   * The client swiped to a video. Nothing is done to the remote page: the answer comes from TikTok's item list, so a swipe
   * costs one cheap request instead of a scroll and a re-read of the page. The page is moved only when something has to
   * act on that video (like, comments — see [pin]).
   */
  async goto(id: string): Promise<{ items: FeedItem[]; current: string | null }> {
    const cat = this.catalog?.byIdLookup(id) ?? null;
    if (cat) {
      this.lastId = id;
      const items: FeedItem[] = [this.fromCatalog(cat)];
      this.addAhead(items, id, GOTO_ITEMS, []);
      // Background work never queues behind the user's own actions on the chain.
      void this.run(async () => {
        const agent = await this.ensureAgent();
        await agent.hold().catch(() => undefined);
        void this.warmAhead(agent);
        void this.extendIfShort(agent, id);
      }).catch(() => undefined);
      return { items, current: id };
    }
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const res = await agent.ensureItem(id).catch(() => ({ ok: false as const }));
      if (!res.ok) throw new AppError(409, 'feed_moved', 'That video is not in the feed any more. Reload the feed.');
      await sleep(400);
      await agent.hold().catch(() => undefined);
      const raw = await agent.current().catch(() => null);
      const items: FeedItem[] = [];
      if (raw) items.push(this.toItem(raw));
      this.addAhead(items, raw?.id ?? null, GOTO_ITEMS, await agent.queue(GOTO_ITEMS + 3).catch(() => []));
      this.lastId = raw?.id ?? this.lastId;
      void this.warmAhead(agent);
      return { items, current: raw?.id ?? null };
    });
  }

  /**
   * Keeps TikTok's list ahead of the client: when fewer than [AHEAD_MIN] videos follow [anchor] the page is scrolled to
   * its last rendered video, which is what makes it request the next batch. One at a time, and not more than every 3 s.
   */
  private extendIfShort(agent: FeedAgent, anchor: string | null): Promise<void> {
    if (!this.catalog || this.extending) return this.extending ?? Promise.resolve();
    if (this.catalog.after(anchor, AHEAD_MIN).length >= AHEAD_MIN) return Promise.resolve();
    if (Date.now() - this.lastExtend < 3000) return Promise.resolve();
    this.lastExtend = Date.now();
    const catalog = this.catalog;
    this.extending = (async () => {
      const before = catalog.size;
      await agent.edge('end').catch(() => undefined);
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && catalog.size === before) await sleep(300);
    })()
      .catch(() => undefined)
      .finally(() => {
        this.extending = null;
      });
    return this.extending;
  }

  /** A feed item built from TikTok's item list (not from the page): the videos ahead of the one in view. */
  private fromCatalog(c: CatalogItem): FeedItem {
    return {
      id: c.id,
      url: `${this.origin}/@${c.author ?? ''}/video/${c.id}`,
      author: { username: c.author, name: c.authorName, avatar: c.avatar ? this.media.ref(c.avatar) : null },
      caption: c.desc,
      music: c.music,
      stats: { likes: c.likes, comments: c.comments, shares: c.shares, plays: c.plays },
      liked: c.liked ?? false,
      video: c.playAddr || c.cover ? { src: c.playAddr ? this.media.ref(c.playAddr) : null, poster: c.cover ? this.media.ref(c.cover) : null, muted: true, playing: false } : null,
    };
  }

  /** A feed item built from the page's list (not from the video in view): used for the items ahead. */
  private fromQueue(q: RawQueueItem): FeedItem | null {
    const known = this.catalog?.byIdLookup(q.id) ?? null;
    const id = q.id ?? (q.author ? `f:${q.author}:${(q.caption ?? '').slice(0, 24).replace(/\s+/g, '_') || 'video'}` : null);
    if (!id) return null;
    const src = q.playAddr ?? known?.playAddr ?? null;
    const posterSrc = q.cover ?? known?.cover ?? null;
    const pick = (...xs: (number | null | undefined)[]): number | null => xs.find((x) => typeof x === 'number') ?? null;
    return {
      id,
      url: `${this.origin}/@${q.author ?? ''}/video/${id}`,
      author: {
        username: q.author,
        name: q.authorName,
        avatar: q.avatar ? this.media.ref(q.avatar) : null,
      },
      caption: q.caption ?? q.desc ?? known?.desc ?? null,
      music: q.music ?? q.dMusic ?? known?.music ?? null,
      stats: {
        likes: pick(q.stats.likes, q.dLikes, known?.likes),
        comments: pick(q.stats.comments, q.dComments, known?.comments),
        shares: pick(q.stats.shares, q.dShares, known?.shares),
        plays: pick(q.stats.plays, q.dPlays, known?.plays),
      },
      liked: q.liked,
      video: src || posterSrc ? { src: src ? this.media.ref(src) : null, poster: posterSrc ? this.media.ref(posterSrc) : null, muted: true, playing: false } : null,
    };
  }

  /* ---------------------------------------------------------------- pinning */

  /**
   * Makes sure the page is showing the video the UI is talking about.
   *
   * TikTok's page plays and advances by itself, so between reading the feed and liking or opening the comments of that
   * video the page may already have moved on — which used to fail with "that video is not on screen any more". The page
   * is therefore held on the visible video after every read, and a request for another one scrolls it back.
   */
  private async pin(agent: FeedAgent, id: string | null): Promise<void> {
    const cur = await agent.current().catch(() => null);
    if (!id || !cur?.id || cur.id === id) return;
    // The UI may be far from the page now (swipes never move it): walk the page towards the video, a screen of rendered
    // items at a time, until TikTok has it on screen.
    const target = this.catalog?.indexOf(id) ?? -1;
    const here = this.catalog?.indexOf(cur.id) ?? -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const res = await agent.ensureItem(id).catch(() => ({ ok: false as const }));
      if (res.ok) {
        await sleep(500);
        await agent.hold().catch(() => undefined);
        return;
      }
      if (target < 0 || here < 0) break;
      await agent.edge(target > here ? 'end' : 'start').catch(() => undefined);
      await sleep(450);
    }
    throw new AppError(409, 'feed_moved', 'That video is not on screen any more.');
  }

  /** Shares the video into a chat as a card (the catalogue holds the author ids a card needs). */
  async share(id: string, chatId: string): Promise<{ id: string }> {
    const item = this.catalog?.byIdLookup(id) ?? null;
    if (!item?.authorId) throw new AppError(409, 'share', 'TikTok did not say who posted that video, so it cannot be shared as a card.');
    const sent = await this.ctx.tt.sender.sendShare(chatId, {
      itemId: item.id,
      uid: item.authorId,
      ...(item.authorSecUid ? { secUid: item.authorSecUid } : {}),
      ...(item.authorName ? { name: item.authorName } : {}),
      ...(item.desc ? { title: item.desc.slice(0, 120) } : {}),
      ...(item.cover ? { cover: { urls: [item.cover] } } : {}),
      // TikTok's card carries the author's avatar as `content_thumb`; the cover there gets the message dropped.
      ...((item.avatar ?? item.cover) ? { thumb: { urls: [item.avatar ?? item.cover] as string[] } } : {}),
      ...(item.videoWidth ? { width: item.videoWidth } : {}),
      ...(item.videoHeight ? { height: item.videoHeight } : {}),
    });
    return { id: sent.id ?? '' };
  }

  /* ------------------------------------------------------------------ like */

  /**
   * A like for an item that may not be anywhere in the page's own list.
   *
   * Our feed order comes from the web API; the page's For You order is its own, so an item further ahead is not
   * reachable by scrolling. When the page does not have it, the video's own page is opened first — there its like
   * control is by definition on screen — and the normal like runs on top of that.
   */
  async likeOnVideo(id: string, want: boolean): Promise<{ liked: boolean }> {
    // One step of the chain: the navigation and the click must not interleave with another feed call.
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const rendered = await agent.ensureItem(id).catch(() => ({ ok: false as const }));
      if (!rendered.ok) await this.openVideo(id);
      return this.likeNow(id, want);
    });
  }

  /** Opens `/<author>/video/<id>` in the feed tab (a new document, so the in-page helpers are installed again). */
  private async openVideo(id: string): Promise<void> {
    const c = this.catalog?.byIdLookup(id);
    const agent = await this.ensureAgent();
    if (!c?.author || !this.page) throw new AppError(409, 'feed_moved', 'That video is not in the feed any more. Swipe to it again.');
    const url = videoPageUrl(this.origin, c.author, id);
    if (this.page.url() === url) return; // already there: the like is for the video on screen
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    await agent.install().catch(() => undefined);
    await this.waitForItem(15_000);
  }

  /** Likes (or un-likes) the video in view. Refuses when the feed moved on to another video. */
  async like(id: string, want: boolean): Promise<{ liked: boolean }> {
    return this.run(() => this.likeNow(id, want));
  }

  /** The like itself, run inside the chain ([like] and [likeOnVideo] add it). */
  private async likeNow(id: string, want: boolean): Promise<{ liked: boolean }> {
    const agent = await this.ensureAgent();
    await this.pin(agent, id);
    const item = await agent.current().catch(() => null);
    if (!item) throw new AppError(409, 'feed_moved', 'The feed changed. Reload the video and try again.');
    if (item.liked === want) {
      this.catalog?.markLiked(id, item.liked);
      return { liked: item.liked };
    }
    await agent.like();
    const deadline = Date.now() + 4000;
    let liked = item.liked;
    while (Date.now() < deadline) {
      await sleep(300);
      const now = await agent.current().catch(() => null);
      if (!now) continue;
      liked = now.liked;
      if (liked === want) {
        this.catalog?.markLiked(id, liked);
        return { liked };
      }
    }
    // TikTok may not expose the state; report what we see rather than pretending.
    return { liked };
  }

  /* -------------------------------------------------------------- comments */

  async comments(id: string): Promise<FeedComment[]> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      await this.pin(agent, id);
      await this.freshComments(agent);
      // The panel opens before its rows are filled (placeholders render first), so wait for real text: returning at
      // `open` alone showed an empty comment list on every video.
      const deadline = Date.now() + 9000;
      let seen: { id: string; author: { username: string | null; name: string | null; avatar: string | null }; text: string; likes: number | null; replies: unknown[] }[] = [];
      while (Date.now() < deadline) {
        const panel = await agent.comments().catch(() => null);
        if (panel?.open) {
          seen = panel.comments;
          if (seen.some((c) => c.text.trim())) return seen.map(toComment);
        }
        await sleep(300);
      }
      if (seen.length === 0) throw new AppError(504, 'comments_timeout', "TikTok's comments did not open. Try again.");
      return seen.map(toComment);
    });
  }

  /** Closes a panel left open by another video (it would be read as this video's comments), then opens this one's. */
  private async freshComments(agent: FeedAgent): Promise<void> {
    const open = await agent.comments().catch(() => null);
    if (open?.open) {
      await agent.closeComments().catch(() => undefined);
      for (let i = 0; i < 8; i++) {
        await sleep(250);
        if (!(await agent.comments().catch(() => null))?.open) break;
      }
    }
    await agent.openComments();
  }

  async comment(id: string, text: string): Promise<FeedComment[]> {
    const body = text.trim();
    if (!body) throw Errors.validation('The comment is empty.');
    if (body.length > 150) throw Errors.validation('TikTok comments are limited to 150 characters.');
    return this.run(async () => {
      const agent = await this.ensureAgent();
      await this.pin(agent, id);
      await this.freshComments(agent);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const panel = await agent.comments().catch(() => null);
        if (panel?.open) break;
        await sleep(300);
      }
      const res = await agent.postComment(body);
      if (!res.ok) throw new AppError(502, 'comment', "TikTok's comment box was not found. Try on the TikTok screen.");
      this.ctx.repo.audit('feed_comment', null, 'comment');
      // Wait for it to appear in the list (TikTok adds it optimistically or after the round trip).
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        await sleep(500);
        const panel = await agent.comments().catch(() => null);
        if (panel?.open && panel.comments.some((c) => c.text.trim() === body)) return panel.comments.map(toComment);
      }
      const panel = await agent.comments().catch(() => null);
      return (panel?.comments ?? []).map(toComment);
    });
  }

  async closeComments(): Promise<void> {
    await this.run(async () => {
      const agent = this.agent;
      if (agent) await agent.closeComments().catch(() => undefined);
    });
  }

  /* ----------------------------------------------------------------- media */

  /**
   * Downloads the next videos before they are asked for, so a swipe does not wait for TikTok. The page already knows
   * their signed URLs (the item bundle) — nothing is guessed, and nothing is stored anywhere but memory.
   */
  private async warmAhead(agent: FeedAgent): Promise<void> {
    const dl = this.downloader;
    if (!dl) return;
    let warmed = 0;
    const warm = (url: string | null, cover: string | null): void => {
      if (!url || warmed >= PRELOAD_AHEAD || this.media.cached(refOf(url))) return;
      this.media.ref(url);
      this.media.prefetch(url, dl);
      if (cover) this.media.ref(cover);
      warmed++;
    };
    // TikTok's item list knows every queued video, in order, with its URL: that is the source of truth.
    for (const c of this.catalog?.after(this.lastId, PRELOAD_AHEAD + 2) ?? []) warm(c.playAddr, c.cover);
    if (warmed >= PRELOAD_AHEAD) return;
    // Otherwise the page's own bundle: it adds items as it loads, so a second look a moment later finds more.
    for (let pass = 0; pass < 2 && warmed < PRELOAD_AHEAD; pass++) {
      if (pass) await sleep(1200);
      try {
        for (const q of await agent.queue(PRELOAD_AHEAD + 4)) {
          if (this.lastId && q.id === this.lastId) continue;
          const known = q.playAddr ? null : this.catalog?.byIdLookup(q.id) ?? null;
          warm(q.playAddr ?? known?.playAddr ?? null, q.cover ?? known?.cover ?? null);
        }
      } catch {
        return; // warming is best-effort: it must never break the feed
      }
    }
  }

  /** The bytes behind a media reference (video or poster), from the cache or downloaded once. */
  async mediaOf(ref: string): Promise<Fetched | null> {
    if (!this.media.urlOf(ref)) return null;
    const got = await this.ensureAgent();
    void got;
    const dl = this.downloader;
    if (!dl) throw Errors.unavailable('The TikTok connection is not open.');
    return this.media.get(ref, dl);
  }

  /** True when the bytes are cached (the route answers instantly and can advertise a long cache). */
  mediaCached(ref: string): boolean {
    return this.media.cached(ref);
  }

  mediaStats(): { refs: number; cached: number; bytes: number; inflight: number } {
    return this.media.stats();
  }
}

function absolute(href: string, origin: string): string {
  try {
    return new URL(href, origin).toString();
  } catch {
    return `${origin}/`;
  }
}

function toComment(c: { id: string; author: { username: string | null; name: string | null; avatar: string | null }; text: string; likes: number | null; replies: unknown[] }): FeedComment {
  return {
    id: c.id,
    author: { username: c.author.username, name: c.author.name },
    text: c.text,
    likes: c.likes,
    replies: (c.replies as Parameters<typeof toComment>[0][]).slice(0, 10).map(toComment),
  };
}

/**
 * The video's own page (`https://www.tiktok.com/@author/video/<id>`).
 *
 * Used when a like has to be made through TikTok's control but the page's own For You list does not render the item:
 * on its own page the video is on screen by definition.
 */
export function videoPageUrl(origin: string, author: string | null, id: string): string {
  const base = origin.replace(/\/+$/, '');
  return author ? `${base}/@${author}/video/${id}` : `${base}/video/${id}`;
}

function syntheticItemId(raw: RawFeedItem): string {
  const who = raw.author.username ?? 'unknown';
  return `f:${who}:${(raw.caption ?? '').slice(0, 24).replace(/\s+/g, '_') || 'video'}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
