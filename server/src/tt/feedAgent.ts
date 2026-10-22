import type { Page } from 'puppeteer';

/**
 * Reading and driving TikTok's For You feed.
 *
 * Same approach as the messages page (dom.ts): TikTok signs everything, so the page stays the client and this agent
 * only reads what the page shows and clicks what a person would click (next/previous, like, comments). Every role has
 * a list of candidate selectors (TikTok's `data-e2e` names first) and a heuristic, and a structure probe is available
 * through the diagnostics screen so a rename can be fixed with `TT_DOM_SELECTORS`.
 *
 * The feed is deliberately read-only where it can be: nothing is posted except a comment the user typed, and no
 * video is downloaded to disk — it is streamed through the browser while it plays.
 */

export interface FeedSelectors {
  item: string[];
  video: string[];
  author: string[];
  caption: string[];
  music: string[];
  likeButton: string[];
  likeCount: string[];
  commentButton: string[];
  commentCount: string[];
  shareCount: string[];
  playCount: string[];
  nextButton: string[];
  prevButton: string[];
  commentPanel: string[];
  commentRow: string[];
  commentText: string[];
  commentLike: string[];
  commentInput: string[];
  commentPost: string[];
}

export const DEFAULT_FEED_SELECTORS: FeedSelectors = {
  item: [
    '[data-e2e="recommend-list-item-container"]',
    '[data-e2e="feed-item"]',
    '[data-e2e="browse-video"]',
    '[class*="DivItemContainer"]',
    '[class*="DivVideoContainer"]',
    'article',
  ],
  video: ['video'],
  author: ['[data-e2e="browse-username"]', '[data-e2e="video-author-uniqueid"]', 'a[href^="/@"]'],
  caption: ['[data-e2e="browse-video-desc"]', '[data-e2e="video-desc"]', '[class*="DivVideoDesc"]', 'h1'],
  music: ['[data-e2e="browse-music"]', 'a[href*="/music/"]', '[class*="DivMusic"]'],
  likeButton: ['[data-e2e="like-icon"]', '[data-e2e="browse-like-icon"]', 'button[aria-label*="like" i]', '[class*="LikeIcon"]'],
  likeCount: ['[data-e2e="like-count"]', 'strong[data-e2e="like-count"]'],
  commentButton: ['[data-e2e="comment-icon"]', '[data-e2e="browse-comment-icon"]', 'button[aria-label*="comment" i]'],
  commentCount: ['[data-e2e="comment-count"]', 'strong[data-e2e="comment-count"]'],
  shareCount: ['[data-e2e="share-count"]', 'strong[data-e2e="share-count"]'],
  playCount: ['[data-e2e="video-views"]', 'strong[data-e2e="video-views"]'],
  nextButton: ['[data-e2e="arrow-right"]', 'button[aria-label*="next" i]', '[class*="ArrowRight"]'],
  prevButton: ['[data-e2e="arrow-left"]', 'button[aria-label*="previous" i]', '[class*="ArrowLeft"]'],
  commentPanel: ['[data-e2e="comment-list"]', '[class*="DivCommentListContainer"]', '[class*="CommentListContainer"]'],
  commentRow: ['[data-e2e="comment-level-1"]', '[data-e2e="comment-item"]', '[class*="DivCommentItemContainer"]', '[class*="CommentItem"]'],
  commentText: ['[data-e2e="comment-level-1"] p', '[class*="DivCommentContentContainer"]', '[class*="CommentText"]', 'p'],
  commentLike: ['[data-e2e="comment-like-count"]', '[class*="DivLikeCount"]'],
  commentInput: ['[data-e2e="comment-input"] div[contenteditable="true"]', '[data-e2e="comment-input"]', 'div[contenteditable="true"]'],
  commentPost: ['[data-e2e="comment-post"]', 'button[data-e2e*="post"]', 'button[type="submit"]'],
};

const AGENT = String.raw`
(() => {
  if (window.__ttf && window.__ttf.version === 1) return;
  const S = __SELECTORS__;
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const txt = (el) => (el && typeof el.innerText === 'string' ? el.innerText : el && el.textContent ? el.textContent : '').trim();
  const all = (sel, root) => { try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { return []; } };
  const first = (list, root) => { for (const sel of list) { const els = all(sel, root).filter(vis); if (els.length) return els; } return []; };
  const centery = () => window.innerHeight / 2;

  const containers = () => {
    const out = [];
    for (const sel of S.item) {
      for (const el of all(sel)) if (vis(el) && !out.includes(el)) out.push(el);
    }
    return out;
  };

  /** The item under the middle of the viewport (the feed shows one at a time). */
  const currentEl = () => {
    const mid = centery();
    let best = null, bestD = Infinity;
    for (const el of containers()) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestD) { bestD = d; best = el; }
    }
    if (best) return best;
    // Some builds render one video with no per-item container: use the video's own box.
    const v = all('video').filter(vis)[0];
    return v ? v.closest('div, article, section') || v : null;
  };

  const parseStat = (el) => {
    if (!el) return null;
    const t = txt(el).toUpperCase().replace(/,/g, '');
    const m = /([\d.]+)\s*([KMB])?/.exec(t);
    if (!m) return null;
    const n = Number(m[1]) * (m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1);
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  const videoLink = (el) => {
    const a = el.querySelector('a[href*="/video/"]') || all('a[href*="/video/"]').find((x) => vis(x));
    return a ? a.getAttribute('href') : null;
  };

  const idOf = (el) => {
    // The item carries no link to itself, but its "more actions" button is keyed by the video id.
    const keyed = el.querySelector('[data-more-menu-item-id]');
    const keyedId = keyed && keyed.getAttribute('data-more-menu-item-id');
    if (keyedId && /^\d{6,24}$/.test(keyedId)) return keyedId;
    const href = videoLink(el);
    const m = href ? /\/video\/(\d{6,24})/.exec(href) : null;
    if (m) return m[1];
    const attr = el.getAttribute && (el.getAttribute('data-item-id') || el.getAttribute('data-id'));
    return attr && /^\d{6,24}$/.test(attr) ? attr : null;
  };

  const likedNow = (el) => {
    for (const sel of S.likeButton) {
      const btn = all(sel, el).find(vis) || all(sel).find(vis);
      if (!btn) continue;
      if (btn.getAttribute('aria-pressed') === 'true') return true;
      const cls = ((btn.className || '') + ' ' + ((btn.closest('button') || {}).className || '')).toString();
      if (/(is-?liked|liked|active)/i.test(cls)) return true;
      return false;
    }
    return false;
  };

  let hydrationMap = null;
  let hydrationAt = 0;
  /** id -> item struct, from the page's rehydration JSON (TikTok bundles the feed's items with the document). */
  const hydrationItems = () => {
    const now = Date.now();
    if (hydrationMap && now - hydrationAt < 20_000) return hydrationMap;
    const map = new Map();
    const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const text = el && el.textContent ? el.textContent : '';
    if (text && text.length < 4_000_000) {
      try {
        const walk = (node, depth) => {
          if (!node || typeof node !== 'object' || depth > 8 || map.size > 400) return;
          if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
          if (node.id && /^\d{6,24}$/.test(String(node.id)) && (node.video || node.stats)) map.set(String(node.id), node);
          for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') walk(node[k], depth + 1);
        };
        walk(JSON.parse(text), 0);
      } catch (e) {
        /* a truncated payload is not fatal: the DOM alone still works */
      }
    }
    hydrationMap = map;
    hydrationAt = now;
    return map;
  };

  /** What the bundled item struct knows and the DOM does not: the signed video URL and its cover. */
  const detailsFor = (id) => {
    if (!id) return null;
    const it = hydrationItems().get(String(id));
    if (!it) return null;
    const v = it.video || {};
    return {
      playAddr: typeof v.playAddr === 'string' ? v.playAddr : null,
      cover: typeof v.cover === 'string' ? v.cover : null,
      desc: typeof it.desc === 'string' ? it.desc : null,
      music: it.music && typeof it.music.title === 'string' ? it.music.title : null,
      likes: typeof it.stats?.diggCount === 'number' ? it.stats.diggCount : null,
      comments: typeof it.stats?.commentCount === 'number' ? it.stats.commentCount : null,
      shares: typeof it.stats?.shareCount === 'number' ? it.stats.shareCount : null,
      plays: typeof it.stats?.playCount === 'number' ? it.stats.playCount : null,
    };
  };

  const current = () => {
    const el = currentEl();
    if (!el) return null;
    const video = (all('video', el).find(vis) || all('video').find(vis)) || null;
    // The author is the link around the author's avatar: the first link to a profile in the item can be an @mention in
    // the caption (the caption comes first in the DOM), which would name the wrong person and break catalog matching.
    const avatarEl = el.querySelector('[data-e2e="video-author-avatar"], [data-e2e="browse-avatar"]');
    const authorEl = (avatarEl && avatarEl.closest('a[href^="/@"]')) || first(S.author, el)[0] || null;
    const href = authorEl ? authorEl.getAttribute('href') || '' : '';
    const username = (/^\/@([A-Za-z0-9_.]+)/.exec(href) || [])[1] || (authorEl ? txt(authorEl).replace(/^@/, '') : null);
    const captionEl = first(S.caption, el)[0] || null;
    const musicEl = first(S.music, el)[0] || null;
    const img = el.querySelector('img[src]');
    const poster = video && video.getAttribute('poster') ? video.getAttribute('poster') : img && /^https:/.test(img.getAttribute('src') || '') ? img.getAttribute('src') : null;
    const id = idOf(el);
    const r = video ? video.getBoundingClientRect() : el.getBoundingClientRect();
    return {
      id,
      details: detailsFor(id),
      href: videoLink(el),
      author: {
        username: username || null,
        name: authorEl ? (authorEl.getAttribute('title') || txt(authorEl).replace(/^@/, '')) : null,
        avatar: img && /^https:/.test(img.getAttribute('src') || '') ? img.getAttribute('src') : null,
      },
      caption: captionEl ? txt(captionEl) : null,
      music: musicEl ? txt(musicEl).split('\n')[0] : null,
      stats: {
        likes: parseStat(first(S.likeCount, el)[0]),
        comments: parseStat(first(S.commentCount, el)[0]),
        shares: parseStat(first(S.shareCount, el)[0]),
        plays: parseStat(first(S.playCount, el)[0]),
      },
      liked: likedNow(el),
      video: video
        ? {
            src: video.currentSrc || video.getAttribute('src') || null,
            poster: poster || null,
            width: video.videoWidth || Math.round(r.width) || null,
            height: video.videoHeight || Math.round(r.height) || null,
            duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null,
            muted: !!video.muted,
            playing: !video.paused,
          }
        : null,
    };
  };

  const clickIn = (selectors, root) => {
    for (const sel of selectors) {
      const els = all(sel, root).filter(vis);
      if (els.length) { els[els.length - 1].click(); return true; }
    }
    return false;
  };

  const step = (dir) => {
    const el = currentEl();
    const clicked = clickIn(dir === 'next' ? S.nextButton : S.prevButton, el || document) || clickIn(dir === 'next' ? S.nextButton : S.prevButton, document);
    if (clicked) return { ok: true, via: 'button' };
    // Keyboard is the fallback; TikTok's feed listens for the arrow keys on the document.
    const ev = (type) => new KeyboardEvent(type, { key: dir === 'next' ? 'ArrowDown' : 'ArrowUp', code: dir === 'next' ? 'ArrowDown' : 'ArrowUp', keyCode: dir === 'next' ? 40 : 38, bubbles: true, cancelable: true });
    for (const t of ['keydown', 'keyup']) document.dispatchEvent(ev(t));
    return { ok: true, via: 'keyboard' };
  };

  const like = () => {
    const el = currentEl();
    if (!clickIn(S.likeButton, el || document)) return { ok: false, error: 'no_like_button' };
    return { ok: true };
  };

  const commentPanel = () => first(S.commentPanel)[0] || null;

  const openComments = () => {
    if (commentPanel()) return { ok: true, open: true };
    if (!clickIn(S.commentButton, currentEl() || document)) return { ok: false, error: 'no_comment_button' };
    return { ok: true, open: false };
  };

  const closeComments = () => {
    const panel = commentPanel();
    if (!panel) return { ok: true };
    const close = all('[aria-label*="close" i], [data-e2e*="close"]', panel.parentElement || panel).find(vis);
    if (close) { close.click(); return { ok: true }; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return { ok: true };
  };

  const commentId = (row, i) => {
    const attr = row.getAttribute && (row.getAttribute('data-id') || row.getAttribute('data-cid'));
    if (attr) return attr;
    const a = row.querySelector('a[href^="/@"]');
    const who = a ? (a.getAttribute('href') || '') : '';
    return 'c:' + i + ':' + (who + ':' + txt(row).slice(0, 60)).replace(/\s+/g, ' ').slice(0, 90);
  };

  const readComment = (row, i) => {
    const a = row.querySelector('a[href^="/@"]');
    const href = a ? a.getAttribute('href') || '' : '';
    const textEl = first(S.commentText, row)[0] || row;
    const body = textEl === row ? txt(row) : txt(textEl);
    const likeEl = first(S.commentLike, row)[0];
    const replies = all('[data-e2e="comment-level-2"]', row).slice(0, 20).map((r2, j) => readComment(r2, j));
    return {
      id: commentId(row, i),
      author: {
        username: (/^\/@([A-Za-z0-9_.]+)/.exec(href) || [])[1] || (a ? txt(a).replace(/^@/, '') : null),
        name: a ? a.getAttribute('title') || null : null,
        avatar: (() => { const img = row.querySelector('img[src]'); return img && /^https:/.test(img.getAttribute('src') || '') ? img.getAttribute('src') : null; })(),
      },
      text: body.replace(/\s+\d+[KMB]?$/i, '').trim().slice(0, 500),
      likes: parseStat(likeEl),
      replies,
    };
  };

  const comments = () => {
    const panel = commentPanel();
    if (!panel) return { open: false, comments: [] };
    const rows = first(S.commentRow, panel).filter((row) => !row.parentElement || !row.parentElement.closest('[data-e2e="comment-level-1"]'));
    return { open: true, comments: rows.slice(0, 60).map((row, i) => readComment(row, i)) };
  };

  const postComment = (text) => {
    const panel = commentPanel();
    if (!panel) return { ok: false, error: 'no_panel' };
    const input = first(S.commentInput, panel)[0] || first(S.commentInput)[0];
    if (!input) return { ok: false, error: 'no_input' };
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
    const typed = document.execCommand('insertText', false, text);
    if (!typed) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    // The submit control usually sits next to the box, outside the list container: look in the panel, then the page.
    const posted = clickIn(S.commentPost, panel) || clickIn(S.commentPost, document);
    if (!posted) {
      for (const t of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    }
    return { ok: true, via: posted ? 'button' : 'enter' };
  };

  window.__ttf = {
    version: 1,
    current: () => current(),
    step: (d) => step(d),
    like: () => like(),
    openComments: () => openComments(),
    closeComments: () => closeComments(),
    comments: () => comments(),
    postComment: (t) => postComment(t),
    state: () => ({ url: location.pathname, hasItem: !!currentEl() }),
  };
  return true;
})()
`;

/** Selectors from the environment extend the defaults (same rule as the messages agent). */
export function mergeFeedSelectors(extra?: Record<string, string[]> | null): FeedSelectors {
  const out: FeedSelectors = { ...DEFAULT_FEED_SELECTORS };
  if (!extra) return out;
  for (const k of Object.keys(DEFAULT_FEED_SELECTORS) as (keyof FeedSelectors)[]) {
    const v = extra[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length < 200)) out[k] = [...new Set([...v, ...DEFAULT_FEED_SELECTORS[k]])].slice(0, 20);
  }
  return out;
}

/** What the page reports about the video in view. */
export interface RawFeedItem {
  id: string | null;
  /** Straight from the page's bundled item struct: signed video URL, cover, exact stats. */
  details: {
    playAddr: string | null;
    cover: string | null;
    desc: string | null;
    music: string | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    plays: number | null;
  } | null;
  href: string | null;
  author: { username: string | null; name: string | null; avatar: string | null };
  caption: string | null;
  music: string | null;
  stats: { likes: number | null; comments: number | null; shares: number | null; plays: number | null };
  liked: boolean;
  video: { src: string | null; poster: string | null; width: number | null; height: number | null; duration: number | null; muted: boolean; playing: boolean } | null;
}

interface RawComment {
  id: string;
  author: { username: string | null; name: string | null; avatar: string | null };
  text: string;
  likes: number | null;
  replies: RawComment[];
}

export class FeedAgent {
  private installed = false;

  constructor(
    readonly page: Page,
    private selectors: FeedSelectors,
  ) {}

  async install(): Promise<void> {
    if (this.installed) return;
    const source = AGENT.replace('__SELECTORS__', JSON.stringify(this.selectors));
    await this.page.evaluateOnNewDocument(source);
    await this.page.evaluate(source);
    this.installed = true;
  }

  async reset(): Promise<void> {
    this.installed = false;
    await this.install();
  }

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.install();
    return (await this.page.evaluate(
      (m: string, a: unknown[]) => {
        const api = (window as unknown as { __ttf?: Record<string, (...xs: unknown[]) => unknown> }).__ttf;
        if (!api || typeof api[m] !== 'function') throw new Error('feed agent missing');
        return api[m]!(...a);
      },
      method,
      args,
    )) as T;
  }

  current(): Promise<RawFeedItem | null> {
    return this.call('current');
  }

  step(dir: 'next' | 'prev'): Promise<{ ok: boolean; via?: string }> {
    return this.call('step', dir);
  }

  like(): Promise<{ ok: boolean; error?: string }> {
    return this.call('like');
  }

  openComments(): Promise<{ ok: boolean; open?: boolean; error?: string }> {
    return this.call('openComments');
  }

  closeComments(): Promise<{ ok: boolean }> {
    return this.call('closeComments');
  }

  comments(): Promise<{ open: boolean; comments: RawComment[] }> {
    return this.call('comments');
  }

  postComment(text: string): Promise<{ ok: boolean; via?: string; error?: string }> {
    return this.call('postComment', text);
  }
}
