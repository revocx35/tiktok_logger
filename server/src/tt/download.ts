import type { CDPSession, Page } from 'puppeteer';
import { isTikTokCdn, type Downloader, type FetchOutcome } from './media.js';

/**
 * Downloads media through the browser (the app container has no route to the internet). `Network.loadNetworkResource`
 * uses the tab's network stack without sending the page's cookies (`includeCredentials: false`): the signed CDN URL
 * is the only credential, which is exactly how TikTok serves these links.
 */
export class BrowserDownloader implements Downloader {
  private cdp: CDPSession | null = null;
  private frameId: string | null = null;

  /**
   * [inPage]: download with the page's own `fetch` (cookies included, Referer = tiktok.com), in ranged pieces. TikTok's
   * video CDN answers 403 to a request without the session's cookies — `Network.loadNetworkResource` has none — and
   * only videos the page had already loaded (served from the HTTP cache) looked fine. Falls back to the network
   * resource loader for hosts the page may not read (CORS).
   */
  constructor(
    private readonly page: Page,
    private readonly inPage = false,
    /** A non-TikTok origin the page is served from (only the test double). */
    private readonly extraOrigin?: string,
  ) {}

  async attach(): Promise<void> {
    if (!this.cdp) this.cdp = await this.page.createCDPSession();
  }

  async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.frameId = null;
    await cdp?.detach().catch(() => undefined);
  }

  private async mainFrameId(cdp: CDPSession): Promise<string> {
    if (this.frameId) return this.frameId;
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    this.frameId = tree.frameTree.frame.id;
    return this.frameId;
  }

  async fetch(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome> {
    if (this.inPage) {
      // The page's cookies only ever go to TikTok's own hosts, whatever URL the page data names.
      if (!isTikTokCdn(url, this.extraOrigin)) return { status: 'error', reason: 'host' };
      const got = await this.fetchInPage(url, maxBytes, sink);
      if (got.status === 'ok' || got.status === 'too_large') return got;
    }
    return this.fetchResource(url, maxBytes, sink);
  }

  /** Ranged `fetch` in the page, 2 MB at a time (a whole clip in one CDP answer would be a very large string). */
  private async fetchInPage(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome> {
    const PIECE = 2 * 1024 * 1024;
    let at = 0;
    let total = Infinity;
    let mime: string | null = null;
    const deadline = Date.now() + 2 * 60_000;
    while (at < total) {
      if (Date.now() > deadline) return { status: 'error', reason: 'timeout' };
      let r: PieceResult | null;
      try {
        r = await withTimeout(this.page.evaluate(pieceInPage, url, at, at + PIECE - 1), 30_000);
      } catch {
        return { status: 'error', reason: 'page_fetch' };
      }
      if (!r) return { status: 'error', reason: 'timeout' };
      if (!r.ok) return r.status ? { status: 'http', code: r.status } : { status: 'error', reason: r.error ?? 'page_fetch' };
      const b = Buffer.from(r.b64, 'base64');
      mime = r.type || mime;
      // A server that ignores Range answers 200 with the whole body: it is complete after this one piece.
      total = r.whole ? b.length : r.total ?? (b.length < PIECE ? at + b.length : Infinity);
      if (at + b.length > maxBytes || total > maxBytes) return { status: 'too_large' };
      if (b.length) await sink(b);
      if (!b.length) break;
      at += b.length;
    }
    return { status: 'ok', mime, size: at };
  }

  private async fetchResource(url: string, maxBytes: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome> {
    if (!this.cdp) await this.attach();
    const cdp = this.cdp;
    if (!cdp) return { status: 'error', reason: 'detached' };
    let frameId: string;
    try {
      frameId = await this.mainFrameId(cdp);
    } catch {
      this.frameId = null;
      return { status: 'error', reason: 'no_frame' };
    }
    const res = (await withTimeout(
      cdp.send('Network.loadNetworkResource', { frameId, url, options: { disableCache: false, includeCredentials: false } }),
      60_000,
    )) as { resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> } } | null;
    if (!res) return { status: 'error', reason: 'timeout' };
    const rsc = res.resource;
    if (!rsc.success || !rsc.stream) {
      if (rsc.stream) await cdp.send('IO.close', { handle: rsc.stream }).catch(() => undefined);
      return rsc.httpStatusCode ? { status: 'http', code: rsc.httpStatusCode } : { status: 'error', reason: (rsc.netErrorName ?? 'net_error').slice(0, 40) };
    }
    const header = (n: string): string | null => {
      for (const [k, v] of Object.entries(rsc.headers ?? {})) if (k.toLowerCase() === n) return v;
      return null;
    };
    const declared = Number(header('content-length') ?? NaN);
    const handle = rsc.stream;
    try {
      if (Number.isFinite(declared) && declared > maxBytes) return { status: 'too_large' };
      let total = 0;
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        if (Date.now() > deadline) return { status: 'error', reason: 'timeout' };
        const chunk = (await withTimeout(cdp.send('IO.read', { handle, size: 1 << 20 }), 60_000)) as { data: string; base64Encoded?: boolean; eof: boolean } | null;
        if (!chunk) return { status: 'error', reason: 'timeout' };
        const b = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
        total += b.length;
        if (total > maxBytes) return { status: 'too_large' };
        if (b.length) await sink(b);
        if (chunk.eof) break;
      }
      return { status: 'ok', mime: header('content-type'), size: total };
    } finally {
      await cdp.send('IO.close', { handle }).catch(() => undefined);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface PieceResult {
  ok: boolean;
  status?: number;
  error?: string;
  b64: string;
  type: string | null;
  total: number | null;
  whole: boolean;
}

/** Runs inside the TikTok page. Self-contained: it is serialised by puppeteer. */
async function pieceInPage(url: string, from: number, to: number): Promise<PieceResult> {
  try {
    const r = await fetch(url, { credentials: 'include', headers: { Range: `bytes=${from}-${to}` } });
    if (r.status !== 206 && r.status !== 200) return { ok: false, status: r.status, b64: '', type: null, total: null, whole: false };
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const range = /\/(\d+)\s*$/.exec(r.headers.get('content-range') ?? '');
    return { ok: true, b64: btoa(bin), type: r.headers.get('content-type'), total: range ? Number(range[1]) : null, whole: r.status === 200 };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 40), b64: '', type: null, total: null, whole: false };
  }
}
