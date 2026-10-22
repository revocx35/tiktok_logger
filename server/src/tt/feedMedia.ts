import { createHash } from 'node:crypto';
import type { FetchOutcome } from './media.js';

/**
 * Feed videos and posters, kept in memory behind opaque references — the same scheme as insta_logger's Reels.
 *
 * A ref is derived from the URL (so the same video always gets the same ref — the browser can then keep it, and a
 * second request is a cache hit instead of a second download). The first N videos of the feed are fetched in the
 * background as soon as the feed is read, so swiping to them does not wait for a download.
 *
 * TikTok's signed CDN links never reach the client and are never logged; nothing here is written to disk.
 */

export interface Downloader {
  fetch(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome>;
}

export interface Fetched {
  mime: string;
  data: Buffer;
}

/** A single video; TikTok's web feed serves 2–10 MB clips, 64 MB is a generous ceiling. */
export const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_BYTES = 320 * 1024 * 1024;
const CACHE_ENTRY_MAX = 48 * 1024 * 1024;
const REF_TTL_MS = 6 * 3600_000;
const SERVE_MIME = /^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp|avif|gif))$/;

interface Entry {
  url: string;
  until: number;
}

export function refOf(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

/** The MIME to serve for a reference: an explicit type when known, else guessed from the URL's path. */
export function pickMime(header: string | null, url?: string): string | null {
  const base = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (SERVE_MIME.test(base)) return base;
  if (!url) return null;
  const path = url.split('?')[0]!.toLowerCase();
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return null;
}

export class FeedMedia {
  private readonly refs = new Map<string, Entry>();
  private readonly cache = new Map<string, Fetched>();
  private cachedBytes = 0;
  private readonly inflight = new Map<string, Promise<Fetched | null>>();
  /** How many downloads are running right now (prefetching a page must not start a stampede). */
  private fetching = 0;

  constructor(
    private readonly maxConcurrent = 2,
    /** Called with a short reason (never the URL: it is a signed link) when a download did not work. */
    private readonly onFail: (reason: string) => void = () => undefined,
  ) {}

  /** The app URL for a CDN link, stable for as long as the link lives. */
  ref(url: string): string {
    const id = refOf(url);
    const now = Date.now();
    const known = this.refs.get(id);
    if (!known || known.url !== url || known.until <= now) this.refs.set(id, { url, until: now + REF_TTL_MS });
    if (this.refs.size > 4096) this.pruneRefs(now);
    return `/api/feed/media/${id}`;
  }

  urlOf(id: string): string | null {
    const e = this.refs.get(id);
    return e && e.until > Date.now() ? e.url : null;
  }

  /** True when the bytes are already cached (so the route can answer without waiting). */
  cached(id: string): boolean {
    return this.cache.has(id);
  }

  stats(): { refs: number; cached: number; bytes: number; inflight: number } {
    return { refs: this.refs.size, cached: this.cache.size, bytes: this.cachedBytes, inflight: this.inflight.size };
  }

  /** The bytes behind a ref: from the cache, or downloaded once through the browser (concurrent callers share it). */
  async get(id: string, dl: Downloader): Promise<Fetched | null> {
    const hit = this.cache.get(id);
    if (hit) {
      // Most recently used last, so eviction takes the oldest.
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const url = this.urlOf(id);
    if (!url) return null;
    let p = this.inflight.get(id);
    if (!p) {
      p = this.fetchInto(id, url, dl).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /**
   * Starts fetching in the background (warming the next videos). Skips when it is cached, already running, or when
   * [maxConcurrent] downloads are in flight — the visible video must never queue behind prefetches.
   */
  prefetch(url: string, dl: Downloader): void {
    const id = refOf(url);
    if (this.cache.has(id) || this.inflight.has(id)) return;
    if (this.fetching >= this.maxConcurrent) return;
    if (!this.refs.has(id)) this.ref(url);
    void this.get(id, dl).catch(() => undefined);
  }

  private async fetchInto(id: string, url: string, dl: Downloader): Promise<Fetched | null> {
    this.fetching++;
    try {
      const parts: Buffer[] = [];
      let total = 0;
      const out = await dl.fetch(url, MEDIA_MAX_BYTES, async (chunk) => {
        total += chunk.length;
        parts.push(chunk);
      });
      if (this.cachedBytes + total > CACHE_BYTES) this.evict(total);
      if (this.cache.has(id) || total === 0) return this.cache.get(id) ?? null;
      if (out.status !== 'ok') {
        this.onFail(out.status === 'http' ? `http ${out.code}` : out.status === 'error' ? out.reason : out.status);
        return null;
      }
      const mime = pickMime(out.mime, url) ?? 'video/mp4';
      const f: Fetched = { mime, data: Buffer.concat(parts, total) };
      this.put(id, f);
      return f;
    } finally {
      this.fetching--;
    }
  }

  private put(id: string, f: Fetched): void {
    if (f.data.length > CACHE_ENTRY_MAX) return;
    const old = this.cache.get(id);
    if (old) this.cachedBytes -= old.data.length;
    this.cache.set(id, f);
    this.cachedBytes += f.data.length;
    for (const [k, v] of this.cache) {
      if (this.cachedBytes <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cachedBytes -= v.data.length;
    }
  }

  private evict(need: number): void {
    for (const [k, v] of this.cache) {
      if (this.cachedBytes + need <= CACHE_BYTES) break;
      this.cache.delete(k);
      this.cachedBytes -= v.data.length;
    }
  }

  private pruneRefs(now: number): void {
    for (const [id, e] of this.refs) {
      if (e.until <= now || this.refs.size > 3072) this.refs.delete(id);
    }
  }

  clear(): void {
    this.refs.clear();
    this.cache.clear();
    this.cachedBytes = 0;
  }
}
