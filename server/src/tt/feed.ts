import type { Page } from 'puppeteer';
import type { FeedComment, FeedItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { BrowserDownloader } from './download.js';
import { FeedMedia, type Fetched } from './feedMedia.js';
import { FeedAgent, mergeFeedSelectors, type RawFeedItem } from './feedAgent.js';

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
        author?: { uniqueId?: unknown; nickname?: unknown };
        video?: { playAddr?: unknown; play_addr?: unknown; downloadAddr?: unknown; cover?: unknown; originCover?: unknown };
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
  private readonly media = new FeedMedia(PRELOAD_AHEAD);
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
    this.downloader = new BrowserDownloader(got.page);
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

  /* ------------------------------------------------------------------ like */

  /** Likes (or un-likes) the video in view. Refuses when the feed moved on to another video. */
  async like(id: string, want: boolean): Promise<{ liked: boolean }> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const item = await agent.current().catch(() => null);
      if (!item) throw new AppError(409, 'feed_moved', 'The feed changed. Reload the video and try again.');
      if (item.id && id && item.id !== id) throw new AppError(409, 'feed_moved', 'That video is not on screen any more.');
      if (item.liked === want) return { liked: item.liked };
      await agent.like();
      const deadline = Date.now() + 4000;
      let liked = item.liked;
      while (Date.now() < deadline) {
        await sleep(300);
        const now = await agent.current().catch(() => null);
        if (!now) continue;
        liked = now.liked;
        if (liked === want) return { liked };
      }
      // TikTok may not expose the state; report what we see rather than pretending.
      return { liked };
    });
  }

  /* -------------------------------------------------------------- comments */

  async comments(id: string): Promise<FeedComment[]> {
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const item = await agent.current().catch(() => null);
      if (item?.id && id && item.id !== id) throw new AppError(409, 'feed_moved', 'That video is not on screen any more.');
      await agent.openComments();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const panel = await agent.comments().catch(() => null);
        if (panel?.open) return panel.comments.map(toComment);
        await sleep(300);
      }
      throw new AppError(504, 'comments_timeout', "TikTok's comments did not open. Try again.");
    });
  }

  async comment(id: string, text: string): Promise<FeedComment[]> {
    const body = text.trim();
    if (!body) throw Errors.validation('The comment is empty.');
    if (body.length > 150) throw Errors.validation('TikTok comments are limited to 150 characters.');
    return this.run(async () => {
      const agent = await this.ensureAgent();
      const item = await agent.current().catch(() => null);
      if (item?.id && id && item.id !== id) throw new AppError(409, 'feed_moved', 'That video is not on screen any more.');
      await agent.openComments();
      const deadline = Date.now() + 6000;
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
    try {
      const queue = await agent.queue(PRELOAD_AHEAD + 1);
      let warmed = 0;
      for (const q of queue) {
        if (warmed >= PRELOAD_AHEAD) break;
        if (!q.playAddr || (this.lastId && q.id === this.lastId)) continue;
        this.media.ref(q.playAddr);
        this.media.prefetch(q.playAddr, dl);
        if (q.cover) this.media.ref(q.cover);
        warmed++;
      }
    } catch {
      /* warming is best-effort: a failed prefetch must never break the feed */
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

function syntheticItemId(raw: RawFeedItem): string {
  const who = raw.author.username ?? 'unknown';
  return `f:${who}:${(raw.caption ?? '').slice(0, 24).replace(/\s+/g, '_') || 'video'}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
