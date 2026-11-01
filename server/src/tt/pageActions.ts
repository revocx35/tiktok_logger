import type { Page } from 'puppeteer';
import { AppError } from '../errors.js';

/**
 * Actions that TikTok only accepts from its own controls: like, repost and follow.
 *
 * Their requests carry TikTok's ticket-guard headers (`tt-ticket-guard-*`), which only its SDK adds to the calls it
 * makes itself — a plain `fetch` gets 403 "Argus TLB" (digg) or `10402 invalid csrf token` (follow). So the feed window
 * is put where a person would click, the control is clicked once, and what the page then shows is reported back.
 *
 * Where to click (measured live 2026-10-31):
 * - A video's own page (`/@author/video/<id>`) answers **403 "Access denied"** to this browser as a document load,
 *   with or without a Referer; `history.pushState` to it changes the URL and renders nothing. A profile page loads, and
 *   clicking one of its grid links (`[data-e2e="user-post-item"] a[href*="/video/<id>"]`) opens the video in TikTok's
 *   browse view (an in-app navigation, no document load) with `browse-like-icon`, `browse-follow` and the share row's
 *   `video-share-repost` (`aria-label` "Repost" / "Remove repost").
 * - Follow: the profile header's `[data-e2e="follow-button"]` (the one next to `user-title`; the page holds ~20 more
 *   in "suggested accounts"), text "Follow" → "Following" (or "Friends"); unfollowing asks nothing.
 */

export type VideoAction = 'like' | 'repost';

/** How many times the profile grid is scrolled to find an older video (TikTok loads ~16 per page). */
const MAX_SCROLLS = 14;

export function profileUrl(origin: string, username: string): string {
  return `${origin.replace(/\/+$/, '')}/@${encodeURIComponent(username)}`;
}

/** Usernames TikTok allows (letters, digits, `_` and `.`, up to 24); anything else is refused before a page is touched. */
export function validUsername(u: string): boolean {
  return /^[A-Za-z0-9_.]{1,40}$/.test(u);
}

/** The follow state a profile's header button shows, from its text and label (null = not a follow button we know). */
export function followStateOf(text: string | null, aria: string | null): boolean | null {
  const t = (text ?? '').trim().toLowerCase();
  const a = (aria ?? '').trim().toLowerCase();
  if (/^(following|friends|unfollow)\b/.test(t) || /^(following|unfollow)\b/.test(a)) return true;
  if (/^follow( back)?$/.test(t) || /^follow\b/.test(a)) return false;
  return null;
}

/** The repost state the share row's control shows (`aria-label` "Repost" / "Remove repost"). */
export function repostStateOf(aria: string | null): boolean | null {
  const a = (aria ?? '').trim().toLowerCase();
  if (/remove repost|undo repost|reposted/.test(a)) return true;
  if (/^repost$/.test(a)) return false;
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PageActions {
  constructor(private readonly page: () => Promise<{ page: Page; origin: string }>) {}

  /** Opens the video in TikTok's browse view through its author's profile grid. */
  async openVideo(author: string, id: string): Promise<Page> {
    if (!validUsername(author) || !/^\d{6,24}$/.test(id)) throw new AppError(409, 'feed_moved', 'TikTok did not say who posted that video.');
    const { page, origin } = await this.page();
    const open = await page.evaluate(browseOpenFor, id).catch(() => false);
    if (open) return page;
    await page.goto(profileUrl(origin, author), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    let scrolls = 0;
    while (Date.now() < deadline) {
      const r = await page.evaluate(clickGridItem, id).catch(() => 'waiting' as const);
      if (r === 'denied') throw new AppError(502, 'tt_page', 'TikTok refused to show that profile.');
      if (r === 'private') throw new AppError(409, 'private', "That account is private, so TikTok shows none of its videos.");
      if (r === 'clicked') {
        for (let i = 0; i < 20; i++) {
          await sleep(400);
          if (await page.evaluate(browseOpenFor, id).catch(() => false)) return page;
        }
        throw new AppError(502, 'tt_page', 'TikTok did not open the video.');
      }
      if (r === 'scrolled' && ++scrolls > MAX_SCROLLS) break;
      if (r === 'end') break;
      await sleep(r === 'scrolled' ? 1200 : 500);
    }
    throw new AppError(409, 'not_on_profile', `TikTok does not show that video on @${author}'s profile, so it cannot be done from here.`);
  }

  /** Likes/unlikes or reposts/un-reposts the video in the browse view; answers what TikTok then shows. */
  async onVideo(author: string, id: string, action: VideoAction, want: boolean): Promise<boolean> {
    const page = await this.openVideo(author, id);
    // The browse view draws its action column a moment after the video itself (live: ~0.5 s): wait for the control.
    let before: boolean | null | 'missing' = 'missing';
    for (let i = 0; i < 25 && before === 'missing'; i++) {
      before = await page.evaluate(videoState, action).catch(() => 'missing' as const);
      if (before === 'missing') await sleep(250);
    }
    if (before === 'missing') throw new AppError(409, action === 'repost' ? 'no_repost' : 'no_like', action === 'repost' ? 'TikTok shows no repost button for this video (the author may have turned reposts off).' : 'TikTok shows no like button for this video.');
    if (before === want) return want;
    await page.evaluate(clickVideoControl, action);
    let now: boolean | null | 'missing' = before;
    for (let i = 0; i < 16; i++) {
      await sleep(300);
      now = await page.evaluate(videoState, action).catch(() => now);
      if (now === want) return want;
    }
    if (typeof now !== 'boolean') throw new AppError(502, action, 'TikTok did not show whether it worked. Check on the TikTok screen.');
    return now;
  }

  /** Follows/unfollows on the account's profile page; answers what the header button then shows. */
  async follow(username: string, want: boolean): Promise<boolean> {
    if (!validUsername(username)) throw new AppError(400, 'validation', 'That is not a TikTok username.');
    const { page, origin } = await this.page();
    await page.goto(profileUrl(origin, username), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    let state: { text: string | null; aria: string | null } | 'denied' | null = null;
    for (let i = 0; i < 40 && !state; i++) {
      await sleep(400);
      state = await page.evaluate(headerFollow, false).catch(() => null);
    }
    if (state === 'denied') throw new AppError(502, 'tt_page', 'TikTok refused to show that profile.');
    if (!state) throw new AppError(409, 'no_follow', 'TikTok shows no follow button on that profile.');
    const before = followStateOf(state.text, state.aria);
    if (before === null) throw new AppError(502, 'follow', 'The follow button looks different than expected. Check on the TikTok screen.');
    if (before === want) return want;
    await page.evaluate(headerFollow, true);
    let now: boolean | null = before;
    for (let i = 0; i < 16; i++) {
      await sleep(300);
      const s = await page.evaluate(headerFollow, false).catch(() => null);
      if (s && s !== 'denied') now = followStateOf(s.text, s.aria);
      if (now === want) return want;
    }
    if (now === null) throw new AppError(502, 'follow', 'TikTok did not show whether it worked. Check on the TikTok screen.');
    return now;
  }
}

/* ------------------------------------------------------------- in the page (self-contained, serialised) */

function browseOpenFor(id: string): boolean {
  if (!location.pathname.includes(`/video/${id}`)) return false;
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return [...document.querySelectorAll('[data-e2e="browse-like-icon"],[data-e2e="browse-video"]')].some(vis);
}

function clickGridItem(id: string): 'clicked' | 'scrolled' | 'waiting' | 'end' | 'denied' | 'private' {
  if (/Access to .* was denied/i.test(document.body?.innerText?.slice(0, 300) ?? '')) return 'denied';
  const a = document.querySelector<HTMLAnchorElement>(`a[href*="/video/${id}"]`);
  if (a) {
    a.scrollIntoView({ block: 'center' });
    a.click();
    return 'clicked';
  }
  const grid = document.querySelector('[data-e2e="user-post-item-list"]');
  if (!grid) {
    if (document.querySelector('[data-e2e="user-page"]') && /private/i.test(document.querySelector('main')?.innerText.slice(0, 2000) ?? '')) return 'private';
    return 'waiting';
  }
  const w = window as unknown as { __ttlScrollH?: number; __ttlSame?: number };
  const h = document.documentElement.scrollHeight;
  w.__ttlSame = w.__ttlScrollH === h ? (w.__ttlSame ?? 0) + 1 : 0;
  w.__ttlScrollH = h;
  if ((w.__ttlSame ?? 0) >= 4) return 'end';
  window.scrollTo(0, h);
  return 'scrolled';
}

function videoState(action: 'like' | 'repost'): boolean | null | 'missing' {
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  if (action === 'repost') {
    const el = [...document.querySelectorAll('[data-e2e="video-share-repost"]')].find(vis);
    if (!el) return 'missing';
    const a = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
    if (/remove repost|undo repost|reposted/.test(a)) return true;
    if (/^repost$/.test(a)) return false;
    return null;
  }
  const el = [...document.querySelectorAll('[data-e2e="browse-like-icon"]')].find(vis);
  if (!el) return 'missing';
  for (const n of [el, el.closest('button'), el.querySelector('button'), el.parentElement]) {
    const p = n?.getAttribute('aria-pressed');
    if (p === 'true') return true;
    if (p === 'false') return false;
  }
  // No aria-pressed: TikTok paints a liked heart red (its brand red, rgb(254, 44, 85)).
  const fill = el.querySelector('svg path, svg, [fill]');
  const c = fill ? getComputedStyle(fill).fill || getComputedStyle(fill).color : '';
  if (/254,\s*44,\s*85|fe2c55/i.test(c)) return true;
  return null;
}

function clickVideoControl(action: 'like' | 'repost'): boolean {
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sel = action === 'repost' ? '[data-e2e="video-share-repost"]' : '[data-e2e="browse-like-icon"]';
  const el = [...document.querySelectorAll<HTMLElement>(sel)].find(vis);
  if (!el) return false;
  (el.closest('button') ?? el).click();
  return true;
}

/** The header follow button (next to the profile's title); [click] presses it. */
function headerFollow(click: boolean): { text: string | null; aria: string | null } | 'denied' | null {
  if (/Access to .* was denied/i.test(document.body?.innerText?.slice(0, 300) ?? '')) return 'denied';
  const title = document.querySelector('[data-e2e="user-title"]');
  let box: Element | null = title;
  let btn: HTMLElement | null = null;
  for (let i = 0; box && i < 8 && !btn; i++, box = box.parentElement) btn = box.querySelector<HTMLElement>('[data-e2e="follow-button"]');
  if (!btn) return null;
  if (click) btn.click();
  return { text: btn.innerText?.slice(0, 40) ?? null, aria: btn.getAttribute('aria-label')?.slice(0, 80) ?? null };
}
