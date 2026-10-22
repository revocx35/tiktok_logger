import { randomBytes } from 'node:crypto';
import type { Page } from 'puppeteer';
import type { FeedComment, FeedItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { BrowserDownloader } from './download.js';
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

interface MediaRef {
  url: string;
  mime: string | null;
  at: number;
}

const MEDIA_MAX = 200 * 1024 * 1024;
const REF_TTL_MS = 30 * 60_000;
const MAX_REFS = 64;

export class FeedService {
  private agent: FeedAgent | null = null;
  private page: Page | null = null;
  private origin = 'https://www.tiktok.com';
  private downloader: BrowserDownloader | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly refs = new Map<string, MediaRef>();
  private lastId: string | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly provider: FeedPageProvider,
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
    this.refs.clear();
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
      return this.toItem(raw);
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
          return this.toItem(withSrc);
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
    const id = raw.id ?? syntheticItemId(raw);
    const video = raw.video?.src ? this.register(raw.video.src, 'video/mp4') : null;
    const poster = raw.video?.poster ? this.register(raw.video.poster, 'image/jpeg') : null;
    const avatar = raw.author.avatar ? this.register(raw.author.avatar, 'image/jpeg') : null;
    return {
      id,
      url: raw.href ? absolute(raw.href, this.origin) : `${this.origin}/@${raw.author.username ?? ''}/video/${id}`,
      author: { username: raw.author.username, name: raw.author.name, avatar },
      caption: raw.caption,
      music: raw.music,
      stats: raw.stats,
      liked: raw.liked,
      video: raw.video ? { src: video, poster, muted: raw.video.muted, playing: raw.video.playing } : null,
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

  private register(url: string, mime: string | null): string {
    const now = Date.now();
    for (const [ref, v] of this.refs) if (now - v.at > REF_TTL_MS) this.refs.delete(ref);
    const ref = randomBytes(12).toString('hex');
    this.refs.set(ref, { url, mime, at: now });
    while (this.refs.size > MAX_REFS) {
      const oldest = [...this.refs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.refs.delete(oldest[0]);
    }
    return `/api/feed/media/${ref}`;
  }

  /** The MIME type a registered reference is expected to have (used for the response header before streaming). */
  mimeOf(ref: string): string | null {
    return this.refs.get(ref)?.mime ?? null;
  }

  /**
   * Streams a feed media file (video or poster) to the client through the browser. No cookies are sent; the signed CDN
   * URL is the credential. The whole body is sent (no Range): Chrome plays a buffered progressive MP4, and seeking
   * within the buffered part works.
   */
  async streamMedia(ref: string, write: (chunk: Buffer) => Promise<void>): Promise<{ mime: string | null; size: number }> {
    const entry = this.refs.get(ref);
    if (!entry) throw Errors.notFound('Media');
    const agent = await this.ensureAgent();
    void agent;
    const dl = this.downloader;
    if (!dl) throw Errors.unavailable('The TikTok connection is not open.');
    const out = await dl.fetch(entry.url, MEDIA_MAX, write);
    if (out.status !== 'ok') {
      if (out.status === 'too_large') throw new AppError(413, 'too_large', 'That video is larger than the media limit.');
      if (out.status === 'http') throw new AppError(502, 'upstream', `TikTok answered ${out.code}.`);
      throw new AppError(502, 'upstream', 'The video could not be read from TikTok.');
    }
    return { mime: pickMime(out.mime) ?? entry.mime, size: out.size };
  }
}

function pickMime(header: string | null): string | null {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp|avif|gif)|audio\/(mp4|mpeg|aac|ogg))$/.test(base)) return base;
  return null;
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
