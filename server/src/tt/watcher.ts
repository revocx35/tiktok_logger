import type { CDPSession, Page } from 'puppeteer';
import { isImSocket, isImUrl, readBody, readFrame, type FrameRead } from './frames.js';

/**
 * Passive capture of what TikTok's own page receives and sends.
 *
 * Nothing here ever writes into the page or re-signs a request: the page's WebSocket frames and IM API answers are
 * *observed* through the DevTools protocol and handed to the ingest pipeline. That keeps the account's traffic
 * exactly what TikTok expects (its own client, its own signatures) and gives us the server's identifiers, which the
 * DOM alone cannot provide.
 */

export interface RawFrame {
  dir: 'in' | 'out';
  socket: string;
  bytes: Buffer;
  at: number;
}

export interface RawBody {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  at: number;
}

export interface WatcherHandlers {
  frame(f: RawFrame): void;
  body(b: RawBody): void;
  /** The For You feed's own JSON (\`/api/recommend/item_list/\`): item ids and the signed video URLs. */
  feed?(b: RawBody): void;
  /** A top-level navigation of the tab finished (the page is a new document). */
  navigated(url: string): void;
}

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TRACKED = 200;

export class Watcher {
  private cdp: CDPSession | null = null;
  private readonly sockets = new Map<string, boolean>();
  private readonly pending = new Map<string, { url: string; status: number; contentType: string; feed?: boolean }>();
  private readonly recentUrls: string[] = [];
  lastFrameAt: number | null = null;
  frames = 0;
  bodies = 0;

  /**
   * @param extraOrigin a test origin whose `/api/im/` answers count too (the fake TikTok in scripts/dev). Only set
   * when `TT_WEB_ORIGIN` is not tiktok.com — the real deployment passes nothing.
   */
  constructor(
    private readonly page: Page,
    private readonly handlers: WatcherHandlers,
    private readonly extraOrigin: string | null = null,
  ) {}

  private isFeed(raw: string): boolean {
    try {
      const u = new URL(raw);
      return /(^|\.)tiktok\.com$/i.test(u.hostname) && /\/api\/recommend\/item_list\//i.test(u.pathname);
    } catch {
      return false;
    }
  }

  private isIm(raw: string): boolean {
    if (isImUrl(raw)) return true;
    if (!this.extraOrigin) return false;
    try {
      const u = new URL(raw);
      const o = new URL(this.extraOrigin);
      return u.origin === o.origin && /\/(api\/)?(im|dm|messaging|chat|conversation|thread|mail)\b/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  async attach(): Promise<void> {
    if (this.cdp) return;
    const cdp = await this.page.createCDPSession();
    this.cdp = cdp;

    cdp.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
      this.sockets.set(e.requestId, isImSocket(e.url));
    });
    cdp.on('Network.webSocketClosed', (e: { requestId: string }) => this.sockets.delete(e.requestId));

    const onFrame = (dir: 'in' | 'out') => (e: { requestId: string; response?: { opcode: number; payloadData: string }; request?: { opcode: number; payloadData: string } }) => {
      const f = dir === 'in' ? e.response : e.request;
      if (!f || f.opcode !== 2) return;
      const known = this.sockets.get(e.requestId);
      if (known === false) return;
      // Sockets opened before we attached are unknown: decode them once and decide.
      const bytes = Buffer.from(f.payloadData, 'base64');
      if (bytes.length > MAX_FRAME) return;
      if (known === undefined) {
        const probe = readFrame(bytes);
        if (probe.json.length === 0) return;
        this.sockets.set(e.requestId, true);
      } else if (!known) return;
      this.lastFrameAt = Date.now();
      this.frames++;
      this.handlers.frame({ dir, socket: this.socketName(e.requestId), bytes, at: this.lastFrameAt });
    };
    cdp.on('Network.webSocketFrameReceived', onFrame('in'));
    cdp.on('Network.webSocketFrameSent', onFrame('out'));

    cdp.on('Network.responseReceived', (e: { requestId: string; response: { url: string; status: number; mimeType?: string }; type?: string; frameId?: string }) => {
      const r = e.response;
      if (e.type === 'Document' && r.url.startsWith('https://www.tiktok.com/')) {
        this.handlers.navigated(r.url);
        return;
      }
      const feed = this.isFeed(r.url);
      if (!feed && !this.isIm(r.url)) return;
      if (this.pending.size >= MAX_TRACKED) this.pending.clear();
      this.pending.set(e.requestId, { url: r.url, status: r.status, contentType: r.mimeType ?? '', feed });
    });

    cdp.on('Network.loadingFinished', (e: { requestId: string; encodedDataLength?: number }) => {
      const meta = this.pending.get(e.requestId);
      if (!meta) return;
      this.pending.delete(e.requestId);
      if ((e.encodedDataLength ?? 0) > MAX_BODY) return;
      void this.readBody(e.requestId, meta).catch(() => undefined);
    });
    cdp.on('Network.loadingFailed', (e: { requestId: string }) => this.pending.delete(e.requestId));

    await cdp.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024, maxPostDataSize: 256 * 1024 });
  }

  private socketName(requestId: string): string {
    // The URL is not needed downstream (and can carry a token): only a stable label.
    return `s${requestId.slice(-8)}`;
  }

  private async readBody(requestId: string, meta: { url: string; status: number; contentType: string; feed?: boolean }): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const res = (await cdp.send('Network.getResponseBody', { requestId })) as { body: string; base64Encoded: boolean };
    const body = Buffer.from(res.body, res.base64Encoded ? 'base64' : 'utf8');
    if (body.length === 0 || body.length > MAX_BODY) return;
    this.bodies++;
    if (this.recentUrls.length >= 20) this.recentUrls.shift();
    try {
      this.recentUrls.push(new URL(meta.url).pathname);
    } catch {
      /* ignore */
    }
    const raw = { url: meta.url, status: meta.status, contentType: meta.contentType, body, at: Date.now() };
    if (meta.feed) {
      this.handlers.feed?.(raw);
      return;
    }
    this.handlers.body(raw);
  }

  async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    this.sockets.clear();
    this.pending.clear();
    await cdp?.detach().catch(() => undefined);
  }

  /** Diagnostics: paths of the last IM answers, counts, and whether a stream socket is live. No payloads. */
  diagnostics(): { frames: number; bodies: number; lastFrameAt: number | null; sockets: number; recentPaths: string[] } {
    return { frames: this.frames, bodies: this.bodies, lastFrameAt: this.lastFrameAt, sockets: this.sockets.size, recentPaths: [...this.recentUrls] };
  }

  streamOpen(): boolean {
    for (const v of this.sockets.values()) if (v) return true;
    return false;
  }
}

/** Decodes both kinds of capture in one place, so the service only deals with candidates. */
export function decodeCapture(bytes: Buffer, contentType: string | null = null): FrameRead {
  return contentType === null ? readFrame(bytes) : readBody(bytes, contentType);
}
