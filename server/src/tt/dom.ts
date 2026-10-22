import type { Page } from 'puppeteer';
import type { DomRow, DomThread } from './mapper.js';
import type { PageSnapshot, ThreadSnapshot } from './types.js';
import { toMillis } from './types.js';

/**
 * Reading and driving the TikTok messages page.
 *
 * TikTok's web client is a signed API client: its requests carry X-Bogus/msToken style signatures that only its own
 * JavaScript can produce. So tiktok_logger does not try to sign requests — it lets the page do everything and only
 * reads what the page shows (and what its own traffic carries, see frames.ts/watcher.ts), then drives the composer
 * the way a person would.
 *
 * The agent below is installed into every document of the tab. It is deliberately *tolerant*: TikTok renames things,
 * so every role has a list of candidate selectors, then a heuristic. A role that matches nothing is reported (not
 * thrown) and `probe()` explains what the page looked like, so the selector list can be corrected from Settings →
 * Diagnostics without a new release (`TT_DOM_SELECTORS` in `.env`).
 *
 * The agent never fetches, never stores and never sends anything by itself: Node calls one method and gets plain data.
 */

export interface DomSelectors {
  threadList: string[];
  threadItem: string[];
  threadName: string[];
  threadPreview: string[];
  threadUnread: string[];
  threadAvatar: string[];
  messageList: string[];
  messageRow: string[];
  messageText: string[];
  messageTime: string[];
  composer: string[];
  sendButton: string[];
  fileInput: string[];
  deletedHint: string[];
}

export const DEFAULT_SELECTORS: DomSelectors = {
  threadList: [
    '[data-e2e="conversation-list"]',
    '[data-e2e="chat-list"]',
    '[class*="ConversationList"]',
    '[class*="ThreadList"]',
    '[class*="conversation-list"]',
    '[class*="ChatList"]',
  ],
  threadItem: [
    '[data-e2e="conversation-item"]',
    '[data-e2e="chat-item"]',
    'a[href*="/messages/"]',
    '[class*="ConversationItem"]',
    '[class*="ConversationCell"]',
    '[class*="ThreadItem"]',
    'li[role="listitem"]',
  ],
  threadName: ['[data-e2e="conversation-name"]', '[class*="nickname"]', '[class*="name"]', '[class*="Name"]', 'span', 'p'],
  threadPreview: ['[data-e2e="conversation-preview"]', '[class*="preview"]', '[class*="Preview"]', '[class*="last"]', '[class*="Last"]'],
  threadUnread: ['[data-e2e="unread-count"]', '[class*="badge"]', '[class*="Badge"]', '[class*="unread"]', '[class*="Unread"]'],
  threadAvatar: ['img[src]'],
  messageList: [
    '[data-e2e="message-list"]',
    '[data-e2e="chat-message-list"]',
    '[class*="MessageList"]',
    '[class*="message-list"]',
    '[class*="ChatMessageList"]',
    '[class*="MessageContainer"]',
  ],
  messageRow: [
    '[data-e2e="message-item"]',
    '[data-e2e="chat-message"]',
    '[class*="MessageItem"]',
    '[class*="MessageCell"]',
    '[class*="message-item"]',
    '[class*="Message"]',
  ],
  messageText: ['[data-e2e="message-text"]', '[class*="text"]', '[class*="Text"]', '[class*="content"]', '[class*="Content"]'],
  messageTime: ['time', '[datetime]', '[class*="time"]', '[class*="Time"]', '[class*="timestamp"]'],
  composer: [
    '[data-e2e="message-input"]',
    '[data-e2e="chat-input"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]',
    'textarea',
  ],
  sendButton: ['[data-e2e="message-send"]', '[data-e2e="send-button"]', 'button[aria-label*="Send" i]', '[class*="sendBtn"]', '[class*="Send"]'],
  fileInput: ['input[type="file"]'],
  deletedHint: [
    '[data-e2e="message-deleted"]',
    '[class*="deleted"]',
    '[class*="Deleted"]',
  ],
};

/** The agent, serialized into the page. Keep it dependency-free and side-effect-free. */
const AGENT = String.raw`
(() => {
  if (window.__ttl && window.__ttl.version === 1) return;
  const S = __SELECTORS__;
  const MAX_ROWS = 4000;

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
  const attr = (el, names) => { for (const n of names) { const v = el.getAttribute && el.getAttribute(n); if (v) return v; } return null; };
  const nowMs = () => Date.now();

  const parseTime = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{10,16}$/.test(s)) { let n = Number(s); if (n < 1e12) n *= 1000; if (n > 1e15) n = Math.round(n / 1000); return n; }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };

  const idFrom = (el) => {
    const direct = attr(el, ['data-message-id', 'data-msg-id', 'data-id', 'data-conversation-id', 'data-thread-id']);
    if (direct && /^[A-Za-z0-9_:.\-]{4,128}$/.test(direct)) return direct;
    const href = el.querySelector && el.querySelector('a[href*="/messages/"]');
    const h = href ? href.getAttribute('href') : el.getAttribute && el.getAttribute('href');
    if (h) { const m = /\/messages\/([^/?#]+)/.exec(h); if (m) return decodeURIComponent(m[1]); }
    const idEl = el.querySelector && el.querySelector('[data-e2e*="id"], [class*="id"]');
    const idText = idEl ? txt(idEl) : '';
    if (/^\d{6,24}$/.test(idText)) return idText;
    return null;
  };

  /* --------------------------------------------------------------- threads */

  const threadContainer = () => {
    const found = first(S.threadList);
    if (found.length === 1) return found[0];
    if (found.length > 1) return found[0];
    // Heuristic: the element with the most /messages/ links inside it.
    let best = null, bestN = 0;
    for (const el of all('div, ul, nav, section, aside')) {
      if (!vis(el)) continue;
      const n = el.querySelectorAll('a[href*="/messages/"]').length;
      if (n > bestN) { bestN = n; best = el; }
    }
    if (best && bestN >= 1) return best;
    // Last resort: the widest vertical list in the left third of the screen.
    let cand = null, area = 0;
    for (const el of all('div, ul')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left > window.innerWidth * 0.5 || r.height < 200) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
      const a = r.width * r.height;
      if (a > area) { area = a; cand = el; }
    }
    return cand;
  };

  const threadRows = () => {
    const box = threadContainer();
    if (!box) return [];
    let rows = [];
    const bySel = first(S.threadItem, box);
    if (bySel.length) rows = bySel;
    if (rows.length < 2) {
      const links = all('a[href*="/messages/"]', box);
      if (links.length > rows.length) rows = links;
    }
    if (rows.length < 2) {
      // Direct children that look like rows (have a name line and are not the container itself).
      rows = Array.from(box.children).filter((el) => vis(el) && txt(el).length > 0);
    }
    return rows.slice(0, 300);
  };

  const threads = () => {
    const out = [];
    const seen = new Set();
    for (const row of threadRows()) {
      const lines = txt(row).split(/\n+/).map((s) => s.trim()).filter(Boolean);
      let name = null;
      const nameEls = first(S.threadName, row);
      if (nameEls.length) name = txt(nameEls[0]) || null;
      if (!name && lines.length) name = lines[0];
      if (!name) continue;
      let preview = null;
      const prevEls = first(S.threadPreview, row);
      if (prevEls.length) preview = txt(prevEls[0]) || null;
      if (!preview && lines.length > 1) preview = lines[1];
      const unreadTxt = first(S.threadUnread, row).map(txt).find((t) => /^\d{1,4}\+?$/.test(t));
      const img = row.querySelector('img[src]');
      const avatarUrl = img && /^https:\/\//.test(img.getAttribute('src') || '') ? img.getAttribute('src') : null;
      const id = idFrom(row);
      const key = id || name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id,
        name,
        preview,
        avatarUrl,
        unread: unreadTxt ? Number(unreadTxt.replace('+', '')) : null,
        pinned: attr(row, ['data-pinned']) === 'true',
        muted: attr(row, ['data-muted']) === 'true',
      });
    }
    return out;
  };

  /* -------------------------------------------------------------- messages */

  /**
   * Which conversation the pane shows: the URL when TikTok puts the id there, else the row we clicked (marked with
   * data-ttl-open), else a row the page itself marks as selected. The pane's header name is the last resort.
   */
  const currentThreadId = () => {
    const m = /\/messages\/([^/?#]+)/.exec(location.pathname);
    if (m) return decodeURIComponent(m[1]);
    const marked = all('[data-ttl-open="1"]')[0];
    if (marked) return idFrom(marked);
    const selected = all('[aria-selected="true"], [class*="active"], [class*="selected"], [class*="Active"], [class*="Selected"]').filter((el) => threadContainer() && threadContainer().contains(el) && vis(el));
    for (const el of selected) {
      const id = idFrom(el);
      if (id) return id;
    }
    return null;
  };

  const threadIdFromUrl = () => currentThreadId();

  const messageContainer = () => {
    const found = first(S.messageList).filter((el) => el.getBoundingClientRect().height > 80);
    if (found.length) return found[0];
    // Heuristic: the tallest scrollable element to the right of the thread list.
    let best = null, h = 0;
    for (const el of all('div, ul, section, main')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left < window.innerWidth * 0.25 || r.height < 150) continue;
      const cs = getComputedStyle(el);
      const scrolls = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      if (!scrolls && el.children.length < 3) continue;
      const score = r.height * (scrolls ? 2 : 1);
      if (score > h) { h = score; best = el; }
    }
    return best;
  };

  const rowElements = (box) => {
    let rows = first(S.messageRow, box).filter((el) => !el.contains(box));
    if (rows.length < 2) rows = Array.from(box.children).filter((el) => vis(el) && txt(el).length > 0);
    if (rows.length < 2) {
      // Some builds wrap each message in a positioning div: take grandchildren when children are few.
      const grand = [];
      for (const child of Array.from(box.children)) grand.push(...Array.from(child.children).filter((el) => vis(el) && txt(el).length > 0));
      if (grand.length > rows.length) rows = grand;
    }
    return rows.slice(-MAX_ROWS);
  };

  const bubbleOf = (row) => {
    // The message's own box: the element that holds its picture/video when there is one, else the widest text
    // container. Timestamps and hover metadata are never the bubble (they sit at an edge and would flip the side).
    const media = row.querySelector('img[src], video, video[poster]');
    if (media) {
      let el = media;
      while (el.parentElement && el.parentElement !== row) el = el.parentElement;
      if (vis(el)) return el;
    }
    let best = row, bestW = 0;
    for (const el of Array.from(row.querySelectorAll('div, span, p')).slice(0, 40)) {
      if (!vis(el)) continue;
      const cls = (el.className || '').toString();
      if (/time|Time|stamp|meta|Meta|status/i.test(cls)) continue;
      if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(txt(el))) continue;
      const w = el.getBoundingClientRect().width;
      if (w > bestW) { bestW = w; best = el; }
    }
    return best;
  };

  const isMine = (row, box) => {
    const bubble = bubbleOf(row);
    const cls = ((row.className || '') + ' ' + (bubble.className || '')).toString();
    if (/(right|mine|self|own|outgoing|from-?me|isMe)/i.test(cls)) return true;
    const cs = getComputedStyle(bubble);
    if (cs.alignSelf === 'flex-end' || cs.alignSelf === 'end') return true;
    const parentCs = bubble.parentElement ? getComputedStyle(bubble.parentElement) : null;
    if (parentCs && (parentCs.justifyContent === 'flex-end' || parentCs.justifyContent === 'end')) return true;
    // Layout: an own message sits against the pane's right edge and off its left edge (works for wide photos too).
    const rb = bubble.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const rl = box.getBoundingClientRect();
    if (rb.width < 8 || rl.width < 80) return false; // nothing rendered to measure: do not guess
    const nearRight = rl.right - Math.max(rb.right, rr.right) < 48;
    const offLeft = rb.left - rl.left > Math.max(48, rl.width * 0.2);
    return nearRight && offLeft;
  };

  const rowTime = (row) => {
    for (const sel of S.messageTime) {
      const els = all(sel, row);
      for (const el of els) {
        const t = parseTime(el.getAttribute && (el.getAttribute('datetime') || el.getAttribute('title'))) || parseTime(txt(el));
        if (t) return t;
      }
    }
    const m = /(\d{1,2}:\d{2})(\s*(am|pm))?/i.exec(txt(row));
    if (!m) return null;
    const d = new Date();
    let hh = Number(m[1].split(':')[0]);
    const mm = Number(m[1].split(':')[1]);
    const pm = m[3] && m[3].toLowerCase() === 'pm';
    if (pm && hh < 12) hh += 12;
    if (m[3] && !pm && hh === 12) hh = 0;
    d.setHours(hh, mm, 0, 0);
    let t = d.getTime();
    if (t > nowMs() + 60_000) t -= 86400_000; // "23:50" seen at 00:05 is yesterday
    return t;
  };

  const messages = () => {
    const box = messageContainer();
    if (!box) return { threadId: threadIdFromUrl(), name: null, rows: [], error: 'no_message_list' };
    const out = [];
    const rows = rowElements(box);
    rows.forEach((row, i) => {
      const raw = txt(row);
      if (!raw) return;
      const lower = raw.toLowerCase();
      const deleted = S.deletedHint.some((sel) => { try { return row.matches(sel) || !!row.querySelector(sel); } catch (e) { return false; } })
        || /(message deleted|deleted message|this message was deleted|message unavailable)/i.test(raw);
      const system = /(joined the chat|left the chat|created the group|pinned a message|changed the (group )?(name|photo))/i.test(raw) && raw.length < 200;
      const media = [];
      for (const img of Array.from(row.querySelectorAll('img[src], video[src], video[poster]')).slice(0, 6)) {
        const src = img.getAttribute('src') || img.getAttribute('poster');
        if (!src || !/^https:\/\//.test(src)) continue;
        if (/avatar|profile|emoji/i.test(img.className || '')) continue;
        // A picture inside an avatar/icon-looking container is decoration, not message media. A small picture that
        // has no such context is kept: a CDN link that did not render here still carries the media we want.
        const holder = img.closest('[class*="avatar"], [class*="Avatar"], [class*="icon"], [class*="Icon"], [class*="emoji"], [class*="Emoji"]');
        if (holder && !holder.closest('[class*="msg"], [class*="Msg"], [class*="bubble"], [class*="Bubble"]')) continue;
        media.push({ url: src, kind: img.tagName === 'VIDEO' ? 'video' : 'image' });
      }
      let text = raw;
      for (const sel of S.messageText) {
        const els = all(sel, row).filter(vis);
        if (els.length) { const t = txt(els[els.length - 1]); if (t && t.length >= 3) { text = t; break; } }
      }
      text = text.replace(/\n\d{1,2}:\d{2}(\s*(am|pm))?\s*$/i, '').trim();
      // A media row whose only text is the time stamp has no text at all.
      if (/^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(text)) text = '';
      const idEl = row.querySelector('[data-message-id], [data-msg-id]');
      const id = idEl ? attr(idEl, ['data-message-id', 'data-msg-id', 'data-id']) : null;
      out.push({
        i,
        id: id || null,
        text,
        mine: isMine(row, box),
        ts: rowTime(row),
        media,
        deleted: deleted && !system,
        system,
        senderName: null,
        senderId: null,
        quotedText: null,
      });
    });
    return { threadId: threadIdFromUrl(), name: headerName(), rows: out, error: null };
  };

  const headerName = () => {
    // The conversation header: the first visible heading-ish text right of the thread list, above the message list.
    const box = messageContainer();
    if (!box) return null;
    const top = box.getBoundingClientRect().top;
    const cands = all('h1, h2, h3, header, [class*="Header"], [class*="header"]').filter((el) => {
      if (!vis(el)) return false;
      const r = el.getBoundingClientRect();
      return r.bottom <= top + 8 && r.width > 60 && r.height < 120;
    });
    for (const el of cands) {
      const t = txt(el).split(/\n+/)[0];
      if (t && t.length < 80) return t;
    }
    return null;
  };

  /* ----------------------------------------------------------- interaction */

  const composer = () => {
    for (const sel of S.composer) {
      const els = all(sel).filter(vis);
      if (els.length) return els[els.length - 1];
    }
    return null;
  };

  const openThread = (key) => {
    const rows = threadRows();
    const norm = (s) => (s || '').trim().toLowerCase();
    for (const row of rows) {
      const id = idFrom(row);
      const name = (txt(row).split(/\n+/)[0] || '').trim();
      if ((id && id === key) || norm(name) === norm(key)) {
        const target = row.closest('a') || row;
        for (const el of all('[data-ttl-open="1"]')) el.removeAttribute('data-ttl-open');
        target.setAttribute('data-ttl-open', '1');
        target.scrollIntoView({ block: 'center' });
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        target.click();
        return { ok: true, id, name };
      }
    }
    return { ok: false };
  };

  const clearAndType = (el, text) => {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // contenteditable: select everything, then insert through the editing commands (TikTok listens to input events).
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    return true;
  };

  const setText = (text) => {
    const el = composer();
    if (!el) return { ok: false, error: 'no_composer' };
    clearAndType(el, text);
    const value = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : txt(el);
    return { ok: value.trim() === text.trim(), value };
  };

  const pressKey = (el, key, code, keyCode) => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  };

  const send = () => {
    const el = composer();
    if (!el) return { ok: false, error: 'no_composer' };
    for (const sel of S.sendButton) {
      const btns = all(sel).filter(vis);
      if (btns.length) { btns[btns.length - 1].click(); return { ok: true, via: 'button' }; }
    }
    // No known send selector: a visible button whose text/aria-label says "send" (TikTok localizes the page, so
    // only the English forms are recognised here; Enter below is the localisation-free fallback).
    const labelled = all('button, [role="button"]').filter((b) => vis(b) && /^\s*(send|send message|send now)\s*$/i.test((b.getAttribute('aria-label') || '') + ' ' + txt(b)));
    if (labelled.length) { labelled[labelled.length - 1].click(); return { ok: true, via: 'button' }; }
    pressKey(el, 'Enter', 'Enter', 13);
    return { ok: true, via: 'enter' };
  };

  const attach = (b64, filename, mime) => {
    const inputs = all('input[type="file"]');
    if (!inputs.length) return { ok: false, error: 'no_file_input' };
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename || 'file', { type: mime || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = inputs[inputs.length - 1];
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  };

  const scrollMessages = (dir) => {
    const box = messageContainer();
    if (!box) return false;
    box.scrollTop = dir === 'top' ? 0 : box.scrollHeight;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  };

  const me = () => {
    const out = { id: null, username: null, name: null };
    const scripts = all('script[type="application/json"], script[id*="UNIVERSAL"], script[id*="SIGI"]').slice(0, 6);
    for (const sc of scripts) {
      const t = sc.textContent || '';
      if (!t || t.length > 4_000_000) continue;
      const m = /"userInfo"\s*:\s*\{([^}]{0,4000})\}/.exec(t) || /"currentUser"\s*:\s*\{([^}]{0,2000})\}/.exec(t);
      if (m) {
        const blob = m[1];
        const id = /"(?:uid|userId|id)"\s*:\s*"(\d{3,24})"/.exec(blob);
        const un = /"uniqueId"\s*:\s*"([A-Za-z0-9_.]{1,40})"/.exec(blob);
        const nn = /"nickname"\s*:\s*"([^"]{1,60})"/.exec(blob);
        if (id) out.id = id[1];
        if (un) out.username = un[1];
        if (nn) out.name = nn[1];
        if (out.id) return out;
      }
    }
    return out;
  };

  const loggedIn = () => {
    const p = location.pathname;
    if (/^\/(login|signup)/.test(p) || /\/passport\//.test(p)) return false;
    if (/^\/(for-you|following|explore|@)/.test(p) || p === '/' || /\/messages/.test(p)) return true;
    return false;
  };

  const probe = () => {
    const path = [];
    const cap = 500;
    const walk = (el, depth) => {
      if (path.length >= cap || depth > 14 || !el) return;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r || r.width < 2 || r.height < 2) return;
      const cls = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).map((c) => c.replace(/\d+/g, '#'));
      const tag = el.tagName.toLowerCase();
      const e2e = el.getAttribute('data-e2e');
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label');
      path.push({ d: depth, tag, cls, e2e, role, aria: aria ? aria.slice(0, 40) : null, h: Math.round(r.height), w: Math.round(r.width) });
      for (const c of Array.from(el.children).slice(0, 30)) walk(c, depth + 1);
    };
    walk(document.body, 0);
    return { url: location.pathname, title: document.title.slice(0, 120), nodes: path };
  };

  window.__ttl = {
    version: 1,
    state: () => ({ url: location.pathname, loggedIn: loggedIn(), threadId: threadIdFromUrl(), name: headerName() }),
    threads: () => threads(),
    messages: () => messages(),
    openThread: (key) => openThread(key),
    setText: (t) => setText(t),
    send: () => send(),
    attach: (b64, name, mime) => attach(b64, name, mime),
    scroll: (d) => scrollMessages(d),
    probe: () => probe(),
    me: () => me(),
  };
  return true;
})()
`;

/** Selectors from the environment win over the defaults (per-role arrays extend them). */
export function mergeSelectors(extra?: Partial<DomSelectors> | null): DomSelectors {
  const out: DomSelectors = { ...DEFAULT_SELECTORS };
  if (!extra) return out;
  for (const k of Object.keys(DEFAULT_SELECTORS) as (keyof DomSelectors)[]) {
    const v = extra[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length < 200)) out[k] = [...new Set([...v, ...DEFAULT_SELECTORS[k]])].slice(0, 20);
  }
  return out;
}

interface AgentThread {
  id: string | null;
  name: string | null;
  preview: string | null;
  avatarUrl: string | null;
  unread: number | null;
  pinned: boolean;
  muted: boolean;
}

interface AgentRows {
  threadId: string | null;
  name: string | null;
  rows: DomRow[];
  error: string | null;
}

/** Node-side handle on the agent inside one tab. */
export class DomAgent {
  private installed = false;

  constructor(
    readonly page: Page,
    private selectors: DomSelectors,
  ) {}

  setSelectors(s: DomSelectors): void {
    this.selectors = s;
    void this.install().catch(() => undefined);
  }

  /** Installs the agent in the current document (and in every future one). */
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
        const api = (window as unknown as { __ttl?: Record<string, (...xs: unknown[]) => unknown> }).__ttl;
        if (!api || typeof api[m] !== 'function') throw new Error('agent missing');
        return api[m]!(...a);
      },
      method,
      args,
    )) as T;
  }

  async state(): Promise<PageSnapshot['state']> {
    return this.call('state');
  }

  /** The conversation list, with a name/id per row. */
  async threads(): Promise<DomThread[]> {
    const raw = await this.call<AgentThread[]>('threads');
    return raw
      .filter((t) => t && typeof t.name === 'string' && t.name.length > 0 && t.name.length < 200)
      .map((t) => ({
        id: t.id ?? null,
        name: t.name,
        avatarUrl: t.avatarUrl,
        lastText: t.preview,
        lastTs: null,
        unread: t.unread,
        pinned: t.pinned,
        muted: t.muted,
      }));
  }

  /** The open conversation's messages, oldest first. */
  async messages(): Promise<ThreadSnapshot> {
    const r = await this.call<AgentRows>('messages');
    const rows: DomRow[] = (r.rows ?? []).map((row, i) => ({
      i: typeof row.i === 'number' ? row.i : i,
      id: row.id ?? null,
      text: row.text ?? null,
      mine: row.mine === true,
      ts: toMillis(row.ts ?? null) ?? (typeof row.ts === 'number' ? row.ts : null),
      media: (row.media ?? []).filter((m) => !!m?.url),
      deleted: row.deleted === true,
      system: row.system === true,
      senderName: row.senderName ?? null,
      senderId: row.senderId ?? null,
      quotedText: row.quotedText ?? null,
    }));
    return {
      threadId: r.threadId ?? null,
      name: r.name ?? null,
      rows,
      error: r.error ?? null,
      at: Date.now(),
    };
  }

  async openThread(key: string): Promise<{ ok: boolean }> {
    return this.call('openThread', key);
  }

  /** Types [text] into the composer (no send yet). */
  async setText(text: string): Promise<{ ok: boolean; error?: string; value?: string }> {
    return this.call('setText', text);
  }

  /** Clicks the send button, else presses Enter. */
  async send(): Promise<{ ok: boolean; via?: string; error?: string }> {
    return this.call('send');
  }

  /** Attaches a file through the page's own file input (base64, so nothing has to be shared on disk). */
  async attachBase64(data: Buffer, filename: string, mime: string): Promise<{ ok: boolean; error?: string }> {
    if (data.length > 64 * 1024 * 1024) return { ok: false, error: 'too_large' };
    return this.call('attach', data.toString('base64'), filename, mime);
  }

  async scroll(dir: 'top' | 'bottom'): Promise<boolean> {
    return this.call('scroll', dir);
  }

  async probe(): Promise<{ url: string; title: string; nodes: unknown[] }> {
    return this.call('probe');
  }

  /** The logged-in account as the page itself knows it (empty strings when the page does not say). */
  async me(): Promise<{ id: string | null; username: string | null; name: string | null }> {
    return this.call('me');
  }
}
