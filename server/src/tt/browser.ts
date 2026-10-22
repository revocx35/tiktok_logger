import type { Browser, Page } from 'puppeteer';

/** Where the TikTok tab is, as far as tiktok_logger cares. */
export type PageKind = 'messages' | 'thread' | 'login' | 'challenge' | 'other' | 'blank';

export function classifyUrl(url: string, origin: string): PageKind {
  if (!url.startsWith(`${origin}/`) && url !== origin) return url === 'about:blank' || url === '' ? 'blank' : 'other';
  const u = new URL(url);
  const path = u.pathname;
  if (/^\/messages\/[^/]+/.test(path)) return 'thread';
  if (/^\/messages\/?$/.test(path)) return 'messages';
  if (/^\/(login|signup|logout)(\/|$)/.test(path) || /^\/passport\//.test(path)) return 'login';
  // TikTok's checks after a login attempt (captcha, e-mail/SMS code, "verify it's you", suspended account).
  if (/^\/(verify|challenge|captcha|two-step|account\/(verify|suspended))/.test(path) || /\bverify\b/.test(u.search)) return 'challenge';
  return 'other';
}

/**
 * Uses one tab for TikTok: an existing TikTok tab when there is one (the session lives in the profile anyway),
 * else a blank one. Extra TikTok tabs are closed: two tabs would both hold the message stream, and a second open
 * conversation marks messages as seen twice.
 */
export async function pickTikTokTab(browser: Browser, origin: string): Promise<Page> {
  const pages = await browser.pages();
  const tt = pages.filter((p) => p.url().startsWith(origin));
  let keep: Page | undefined = tt[0] ?? pages.find((p) => classifyUrl(p.url(), origin) === 'blank');
  if (!keep) keep = await browser.newPage();
  for (const p of tt.slice(1)) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  return keep;
}

/** Closes every other tab except [keep] (keeps the VNC screen on TikTok). */
export async function closeOtherTabs(browser: Browser, keep: Page): Promise<void> {
  for (const p of await browser.pages()) if (p !== keep) await p.close({ runBeforeUnload: false }).catch(() => undefined);
  await keep.bringToFront().catch(() => undefined);
}
