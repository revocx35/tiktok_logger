import type { CDPSession, Page } from 'puppeteer';
import type { Downloader, FetchOutcome } from './media.js';

/**
 * Downloads media through the browser (the app container has no route to the internet). `Network.loadNetworkResource`
 * uses the tab's network stack without sending the page's cookies (`includeCredentials: false`): the signed CDN URL
 * is the only credential, which is exactly how TikTok serves these links.
 */
export class BrowserDownloader implements Downloader {
  private cdp: CDPSession | null = null;
  private frameId: string | null = null;

  constructor(private readonly page: Page) {}

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
