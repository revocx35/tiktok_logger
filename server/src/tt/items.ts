import type { TtItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { AppError, Errors } from '../errors.js';
import { FeedMedia, refOf, type Downloader, type Fetched } from './feedMedia.js';
import { WebApiError, type WebApi } from './web/api.js';

/**
 * One TikTok post, resolved through the logged-in tab — what a chat's shared video (or a pasted TikTok link) needs to
 * render as a card you can play instead of a bare link.
 *
 * The call is the one TikTok's own web client makes for a single post: `GET /api/item/detail/?itemId=…`, answered from
 * the messages tab with the page's own signatures (see web/api.ts). Live shape, 2026-10-23:
 * `{status_code: 0, itemInfo: {itemStruct: {id, desc, createTime, author: {id, uniqueId, nickname, avatarThumb},
 * stats: {diggCount, commentCount, shareCount, playCount}, video: {playAddr, cover, duration, width, height}}}}`;
 * an unknown or deleted post answers `status_code: 0` with `statusCode: 10204` and **no** `itemStruct`.
 *
 * The video and the cover are downloaded through the page once (the CDN needs the tab's cookies) into the same kind of
 * in-memory cache the feed uses, and served by the app with byte ranges — mobile browsers refuse a video that cannot be
 * ranged. The signed CDN link never reaches the browser.
 */

const ORIGIN = 'https://www.tiktok.com';
const TTL_MS = 10 * 60_000;
const MAX_ITEMS = 300;
const ID = /^\d{6,24}$/;

export interface ItemDeps {
  /** The web API bound to the messages tab (null while TikTok is not connected). */
  api: () => WebApi | null;
  /** The page downloader (the CDN needs the tab's cookies). */
  downloader: () => Downloader | null;
}

/** What a detail answer says about a post (the signed media links are still raw here). */
export interface ParsedItem {
  id: string;
  url: string;
  desc: string | null;
  author: { id: string | null; username: string | null; name: string | null };
  stats: { likes: number | null; comments: number | null; shares: number | null; plays: number | null };
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Signed video link (null for a photo post). */
  playAddr: string | null;
  /** Poster image link. */
  cover: string | null;
}

/** A resolved post, with the internal media references (the API layer turns them into its own routes). */
export interface ResolvedItem extends Omit<ParsedItem, 'playAddr' | 'cover'> {
  coverRef: string | null;
  videoRef: string | null;
  /** When it was resolved (ms). */
  at: number;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null);

/** The `itemStruct` of a detail answer, or null when TikTok does not have that post. */
export function parseItemDetail(json: unknown): ParsedItem | null {
  const root = obj(json);
  const item = obj(obj(root.itemInfo).itemStruct ?? root.itemStruct);
  const id = str(item.id);
  if (!id || !ID.test(id)) return null;
  const video = obj(item.video);
  const author = obj(item.author);
  const stats = obj(item.stats);
  const username = str(author.uniqueId);
  return {
    id,
    url: username ? `${ORIGIN}/@${username}/video/${id}` : `${ORIGIN}/@_/video/${id}`,
    desc: str(item.desc),
    author: { id: str(author.id), username, name: str(author.nickname) },
    stats: {
      likes: num(stats.diggCount),
      comments: num(stats.commentCount),
      shares: num(stats.shareCount),
      plays: num(stats.playCount),
    },
    durationSec: num(video.duration),
    width: num(video.width),
    height: num(video.height),
    // `playAddr` is a string in today's answers (the object form, `PlayAddrStruct`, belongs to photo posts).
    playAddr: str(video.playAddr),
    cover: str(video.cover) ?? str(video.originCover),
  };
}

export class TtItems {
  private readonly media = new FeedMedia(2, (reason) => this.warn(reason));
  private readonly cache = new Map<string, ResolvedItem>();
  private lastWarn = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: ItemDeps,
  ) {}

  private warn(reason: string): void {
    const now = Date.now();
    if (now - this.lastWarn < 10_000) return;
    this.lastWarn = now;
    this.ctx.log.warn({ reason }, 'item media download failed');
  }

  private web(): WebApi {
    const api = this.deps.api();
    if (!api) throw Errors.unavailable('TikTok is not connected. Log in on the TikTok screen first.');
    return api;
  }

  /** Forgets everything (logout, reconnect). */
  reset(): void {
    this.cache.clear();
    this.media.clear();
  }

  /** The post, from the cache or from TikTok. Throws not_found for a post TikTok does not have. */
  async lookup(id: string): Promise<ResolvedItem> {
    if (!ID.test(id)) throw Errors.notFound('That is not a TikTok post id.');
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    let json: Record<string, unknown>;
    try {
      json = await this.web().json('GET', '/api/item/detail/', { itemId: id });
    } catch (e) {
      if (e instanceof AppError) throw e;
      const why = e instanceof WebApiError ? e.message : 'TikTok did not answer';
      throw new AppError(502, 'item_unavailable', `TikTok did not give that post (${why}).`);
    }
    const parsed = parseItemDetail(json);
    if (!parsed) throw Errors.notFound('That post is gone from TikTok (deleted, private or region-locked).');
    const item: ResolvedItem = {
      ...parsed,
      coverRef: this.register(parsed.cover),
      videoRef: this.register(parsed.playAddr),
      at: Date.now(),
    };
    this.cache.set(id, item);
    if (this.cache.size > MAX_ITEMS) this.cache.delete(this.cache.keys().next().value as string);
    return item;
  }

  /**
   * Registers a CDN link with the byte cache and returns the **cache id**.
   *
   * `FeedMedia.ref()` answers the `/api/feed/media/<id>` path, but `FeedMedia.get()`/`cached()` are keyed by
   * `refOf(url)` — handing the path back made every fetch a miss, which is how the deployed card resolved a post and
   * then served no bytes (found by running this module against the live tab, not by the unit tests, which had a null
   * downloader).
   */
  private register(url: string | null): string | null {
    if (!url) return null;
    this.media.ref(url);
    return refOf(url);
  }

  /** The video or cover bytes (downloaded once through the page, then served from memory). */
  async bytes(id: string, kind: 'video' | 'cover'): Promise<Fetched | null> {
    const item = await this.lookup(id);
    const ref = kind === 'video' ? item.videoRef : item.coverRef;
    if (!ref) return null;
    const dl = this.deps.downloader();
    if (!dl) throw Errors.unavailable('The TikTok connection is not open.');
    return this.media.get(ref, dl);
  }

  /** Bytes already in memory (so the card can show the cover without waiting for a download). */
  cached(id: string, kind: 'video' | 'cover'): boolean {
    const item = this.cache.get(id);
    const ref = item && (kind === 'video' ? item.videoRef : item.coverRef);
    return !!ref && this.media.cached(ref);
  }

  /** The DTO the HTTP layer serves. */
  dto(item: ResolvedItem): TtItem {
    return {
      id: item.id,
      url: item.url,
      desc: item.desc,
      author: { ...item.author, avatarUrl: null },
      stats: item.stats,
      durationSec: item.durationSec,
      width: item.width,
      height: item.height,
      videoUrl: item.videoRef ? `/api/items/${item.id}/media/video` : null,
      coverUrl: item.coverRef ? `/api/items/${item.id}/media/cover` : null,
      ready: this.cached(item.id, 'cover'),
    };
  }
}
