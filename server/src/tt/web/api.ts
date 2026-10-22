import type { PageLike } from '../im/transport.js';

/**
 * TikTok's own web API (`www.tiktok.com/api/...`), called from inside the tab like the IM protocol is.
 *
 * TikTok's page hooks `fetch` and adds the signatures (`X-Bogus`, `X-Gnarly`, `X-Dynosaur`, `msToken`, the CSRF and
 * ticket-guard headers) to any request that carries the browser/device parameters its own requests carry. So the
 * parameters are built here from the page's identity and the call goes through the page's `fetch`: nothing is signed or
 * replayed from outside, and no page is scrolled or clicked. (Measured live: with the full parameter set the comment list
 * answered 200 with data; with `msToken` added by hand, or with fewer parameters, it answered 200 with an empty body.)
 */

export interface WebReply {
  status: number;
  text: string;
}

export class WebApi {
  constructor(private readonly page: PageLike) {}

  /** GET/POST [path] with the standard parameters plus [extra]; the body is empty (TikTok puts everything in the query). */
  async call(method: 'GET' | 'POST', path: string, extra: Record<string, string>): Promise<WebReply> {
    const r = await this.page.evaluate(callInPage, method, path, extra);
    if (r.error) throw new Error(`TikTok request failed: ${r.error}`);
    return { status: r.status, text: r.text };
  }

  /** The JSON answer when TikTok accepted the call (`status_code` 0); throws with TikTok's reason otherwise. */
  async json<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, extra: Record<string, string>): Promise<T> {
    const r = await this.call(method, path, extra);
    if (r.status !== 200) throw new WebApiError(`HTTP ${r.status}`, false);
    // An empty 200 is how TikTok says "I did not like this request" (unsigned or incomplete parameters).
    if (!r.text) throw new WebApiError('TikTok returned an empty answer', false);
    let j: unknown;
    try {
      j = JSON.parse(r.text);
    } catch {
      throw new WebApiError('TikTok returned something that is not JSON', false);
    }
    const code = (j as { status_code?: unknown }).status_code;
    if (typeof code === 'number' && code !== 0) throw new WebApiError(String((j as { status_msg?: unknown }).status_msg ?? `status ${code}`), false, code);
    return j as T;
  }
}

export class WebApiError extends Error {
  constructor(
    message: string,
    /** true when the request may have taken effect (a lost answer) */
    readonly maybeDone: boolean,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Runs in the page; self-contained (serialised by puppeteer). */
async function callInPage(method: string, path: string, extra: Record<string, string>): Promise<{ status: number; text: string; error?: string }> {
  try {
    let ctx: { wid?: string; odinId?: string; region?: string; webIdCreatedTime?: string | number } = {};
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      ctx = (JSON.parse(el?.textContent ?? '{}') as { __DEFAULT_SCOPE__?: Record<string, typeof ctx> }).__DEFAULT_SCOPE__?.['webapp.app-context'] ?? {};
    } catch {
      /* a page without rehydration data: the request will simply be refused */
    }
    const plat = navigator.platform || 'Linux x86_64';
    const base: Record<string, string> = {
      WebIdLastTime: String(ctx.webIdCreatedTime ?? ''),
      aid: '1988',
      app_language: 'en',
      app_name: 'tiktok_web',
      browser_language: navigator.language || 'en-US',
      browser_name: 'Mozilla',
      browser_online: 'true',
      browser_platform: plat,
      browser_version: navigator.userAgent.replace('Mozilla/', ''),
      channel: 'tiktok_web',
      cookie_enabled: 'true',
      data_collection_enabled: 'true',
      device_id: String(ctx.wid ?? ''),
      device_platform: 'web_pc',
      focus_state: 'true',
      history_len: String(history.length),
      is_fullscreen: 'false',
      is_page_visible: 'true',
      odinId: String(ctx.odinId ?? ''),
      os: /mac/i.test(plat) ? 'mac' : /win/i.test(plat) ? 'windows' : 'linux',
      priority_region: String(ctx.region ?? ''),
      referer: '',
      region: String(ctx.region ?? ''),
      root_referer: '',
      screen_height: String(screen.height),
      screen_width: String(screen.width),
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      user_is_login: 'true',
      webcast_language: 'en',
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    try {
      const res = await fetch(`${path}?${new URLSearchParams({ ...base, ...extra }).toString()}`, { method, credentials: 'include', signal: ctl.signal });
      return { status: res.status, text: (await res.text()).slice(0, 4_000_000) };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { status: 0, text: '', error: String(e).slice(0, 80) };
  }
}
