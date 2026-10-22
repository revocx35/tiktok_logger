import { randomBytes } from 'node:crypto';
import { IM_AID, type ImEnv } from './proto.js';

/**
 * Runs the IM requests inside the TikTok tab, the way insta_logger runs Instagram's GraphQL in its tab: the tab
 * already has the session cookies, the right origin, TikTok's own request hooks and the browser's real network stack,
 * and the app container has no internet of its own. Nothing here is signed or replayed from outside the browser.
 *
 * The page function bodies are serialised by puppeteer, so they must stay self-contained.
 */

/** What of puppeteer's Page this needs (the dev probe implements it over raw CDP). */
export interface PageLike {
  evaluate<R, A extends unknown[]>(fn: (...a: A) => R | Promise<R>, ...args: A): Promise<R>;
}

export const IM_ORIGIN = 'https://im-api-sg.tiktok.com';

export interface ImReply {
  status: number;
  body: Buffer;
}

export class ImTransport {
  private env_: { at: number; env: ImEnv; uid: string } | null = null;

  constructor(private readonly page: PageLike) {}

  /** The page's identity for the requests: device id, tokens, browser facts. Cached a minute (msToken rotates). */
  async env(): Promise<{ env: ImEnv; uid: string }> {
    const hit = this.env_;
    if (hit && Date.now() - hit.at < 60_000) return { env: hit.env, uid: hit.uid };
    const r = await this.page.evaluate(readEnvInPage);
    if (!r.deviceId) throw new Error('TikTok has not given this tab a device id yet');
    const env: ImEnv = {
      deviceId: r.deviceId,
      msToken: r.msToken,
      verifyFp: r.verifyFp,
      userAgent: r.userAgent,
      language: r.language,
      platform: r.platform,
      tz: r.tz,
      region: r.region,
      screenW: r.screenW,
      screenH: r.screenH,
      historyLen: r.historyLen,
    };
    this.env_ = { at: Date.now(), env, uid: r.uid };
    return { env, uid: r.uid };
  }

  forget(): void {
    this.env_ = null;
  }

  /** POST a protobuf body to the IM API. `query` is appended as given. */
  async post(path: string, body: Buffer, opts: { query?: Record<string, string>; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<ImReply> {
    const q = new URLSearchParams(opts.query ?? {}).toString();
    const url = `${IM_ORIGIN}${path}${q ? `?${q}` : ''}`;
    const r = await this.page.evaluate(postInPage, url, body.toString('base64'), opts.headers ?? {}, opts.timeoutMs ?? 20_000);
    if (r.error) throw new Error(`IM request failed: ${r.error}`);
    return { status: r.status, body: Buffer.from(r.b64, 'base64') };
  }

  /** Same-origin JSON GET (user profiles). */
  async getJson(url: string): Promise<unknown> {
    const r = await this.page.evaluate(getInPage, url);
    if (r.error || r.status !== 200) throw new Error(`GET failed: ${r.error ?? r.status}`);
    return JSON.parse(r.text);
  }

  /** Query parameters the web client puts on IM calls. */
  async baseQuery(): Promise<Record<string, string>> {
    const { env } = await this.env();
    return { aid: IM_AID, version_code: '1.0.0', app_name: 'tiktok_web', device_platform: 'web_pc', msToken: env.msToken };
  }
}

/** TikTok validates the shape, not the value, of X-Bogus on these endpoints (the real one is added by its page hook). */
export function randomBogus(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const n = 22 + (randomBytes(1)[0]! % 3);
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i]! % alphabet.length];
  return s;
}

/* -------------------------------------------------- functions run in the page */

interface EnvInPage {
  deviceId: string;
  uid: string;
  region: string;
  msToken: string;
  verifyFp: string;
  userAgent: string;
  language: string;
  platform: string;
  tz: string;
  screenW: number;
  screenH: number;
  historyLen: number;
}

function readEnvInPage(): EnvInPage {
  const out: EnvInPage = {
    deviceId: '',
    uid: '',
    region: 'US',
    msToken: '',
    verifyFp: '',
    userAgent: navigator.userAgent,
    language: navigator.language || 'en-US',
    platform: navigator.platform || 'Linux x86_64',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    screenW: screen.width,
    screenH: screen.height,
    historyLen: history.length,
  };
  try {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const j = JSON.parse(el?.textContent ?? '{}') as { __DEFAULT_SCOPE__?: Record<string, { wid?: string; region?: string; user?: { uid?: string } }> };
    const ctx = j.__DEFAULT_SCOPE__?.['webapp.app-context'];
    out.deviceId = String(ctx?.wid ?? '');
    out.region = String(ctx?.region ?? 'US');
    out.uid = String(ctx?.user?.uid ?? '');
  } catch {
    /* the document has no rehydration data */
  }
  const cookie = (name: string): string => {
    for (const part of document.cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return '';
  };
  out.msToken = cookie('msToken');
  out.verifyFp = cookie('s_v_web_id');
  return out;
}

interface PostResult {
  status: number;
  b64: string;
  error?: string;
}

async function postInPage(url: string, b64: string, headers: Record<string, string>, timeoutMs: number): Promise<PostResult> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      signal: ctl.signal,
      headers: { Accept: 'application/x-protobuf', 'Content-Type': 'application/x-protobuf', ...headers },
      body: bytes,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { status: res.status, b64: btoa(s) };
  } catch (e) {
    return { status: 0, b64: '', error: String(e).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

async function getInPage(url: string): Promise<{ status: number; text: string; error?: string }> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: String(e).slice(0, 80) };
  }
}
