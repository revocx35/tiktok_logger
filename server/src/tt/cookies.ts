import { AppError } from '../errors.js';

/*
 * Logging in with the session of the owner's own browser. TikTok's login can keep asking the container's browser for a
 * captcha or a code; then the owner logs in on their own computer and pastes that browser's TikTok cookies. Accepted:
 * DevTools "Copy as cURL" (bash: Chrome `-b '…'` or `-H 'cookie: …'`, Firefox `-H 'Cookie: …'`), a plain Cookie header
 * (`name=value; …`), or a cookie-editor JSON export (`[{name, value, domain}, …]`). Only TikTok's own cookie names are
 * kept, and a jar without the login cookie is rejected with a message that says so. The values are credentials: never
 * logged, never stored anywhere but the Chromium profile.
 */

export interface SessionCookie {
  name: string;
  value: string;
}

/**
 * TikTok's cookies worth carrying over: the login session, the identifiers TikTok ties it to (device ids, CSRF, the
 * signed web tokens) and the store/country hints. Anything else in the jar is dropped (theme, consent, experiments).
 */
const NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'sid_guard',
  'uid_tt',
  'uid_tt_ss',
  'webapp_uid',
  'passport_csrf_token',
  'passport_csrf_token_default',
  'tt_csrf_token',
  'ttwid',
  'tt_chain_token',
  'odin_tt',
  'cmpl_token',
  's_v_web_id',
  'tt_webid',
  'tt_webid_v2',
  'msToken',
  'store-idc',
  'store-country-sign',
]);
export const SESSION_INPUT_MAX = 32_000;
const VALUE = /^[!-:<-~]{1,1024}$/; // printable ASCII, no spaces, no ';'

const invalid = (msg: string) => new AppError(400, 'invalid_cookies', msg);
const NOTHING =
  'Paste the "Copy as cURL" command or the Cookie header of a request to www.tiktok.com from your browser (sent while logged in).';
const LOGGED_OUT =
  'That browser is not logged in to TikTok: the request carries no "sessionid" cookie. Log in at www.tiktok.com in the ' +
  'same browser, open Messages (or any signed-in page), and copy a request from there — the homepage of a signed-out ' +
  'browser only has guest cookies (ttwid, msToken, …).';

/** Splits a shell command into words (bash quoting: '…', "…", $'…', backslashes, line continuations). */
export function shellWords(input: string): string[] {
  const s = input.replace(/\r\n?/g, '\n');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
      continue;
    }
    has = true;
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw invalid(NOTHING);
      cur += s.slice(i + 1, j);
      i = j + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2;
      for (;;) {
        if (i >= s.length) throw invalid(NOTHING);
        const d = s[i]!;
        if (d === "'") break;
        if (d === '\\' && i + 1 < s.length) {
          const n = s[i + 1]!;
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
            i += 4;
          } else {
            cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
            i += 2;
          }
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) throw invalid(NOTHING);
        const d = s[i]!;
        if (d === '"') break;
        if (d === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

function fromHeader(header: string): [string, string][] {
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()] as [string, string]);
}

function fromCurl(command: string): [string, string][] {
  const words = shellWords(command);
  const out: [string, string][] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if ((w === '-b' || w === '--cookie') && next !== undefined) out.push(...fromHeader(next));
    else if (w.startsWith('--cookie=')) out.push(...fromHeader(w.slice('--cookie='.length)));
    else if ((w === '-H' || w === '--header') && next !== undefined && /^cookie\s*:/i.test(next)) out.push(...fromHeader(next.replace(/^cookie\s*:/i, '')));
  }
  return out;
}

function fromJson(text: string): [string, string][] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid(NOTHING);
  }
  if (!Array.isArray(data)) throw invalid(NOTHING);
  const out: [string, string][] = [];
  for (const c of data as unknown[]) {
    if (!c || typeof c !== 'object') continue;
    const { name, value, domain } = c as { name?: unknown; value?: unknown; domain?: unknown };
    if (typeof name !== 'string' || typeof value !== 'string') continue;
    if (typeof domain === 'string' && !/(^|\.)tiktok\.com$/i.test(domain.replace(/^\./, ''))) continue;
    out.push([name, value]);
  }
  return out;
}

/** The TikTok cookies in what the owner pasted. Errors carry generic texts (never a value). */
export function parseSessionCookies(input: string): SessionCookie[] {
  const text = input.trim();
  if (!text || text.length > SESSION_INPUT_MAX) throw invalid(NOTHING);
  const pairs = text.startsWith('[') ? fromJson(text) : /^curl(\.exe)?\s/i.test(text) ? fromCurl(text) : fromHeader(text.replace(/^cookie\s*:/i, ''));
  const found = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (!NAMES.has(name) || found.has(name)) continue;
    if (!VALUE.test(value)) throw invalid(`The value of the "${name}" cookie is not valid. Copy it again.`);
    found.set(name, value);
  }
  // Cookies arrived but none of them is a TikTok name: usually the wrong site's request was copied.
  if (!found.size) throw invalid(pairs.length ? LOGGED_OUT : NOTHING);
  const session = found.get('sessionid') ?? found.get('sessionid_ss') ?? found.get('sid_tt');
  if (!session || session.length < 16) throw invalid(LOGGED_OUT);
  // TikTok's sessionid is an opaque hash; the account ids ride in uid_tt/sid_guard ("<uid>…"). When both are present
  // they must belong to the same account, else the pasted cookies are a mix of two accounts.
  const uid = found.get('uid_tt') ?? found.get('uid_tt_ss') ?? found.get('webapp_uid') ?? null;
  const fromGuard = /^(\d{1,24})/.exec(found.get('sid_guard') ?? '')?.[1] ?? null;
  if (uid && fromGuard && uid !== fromGuard) throw invalid('These cookies belong to two different accounts. Copy them again from one request.');
  if (uid && !/^\d{1,24}$/.test(uid)) throw invalid('The account cookie ("uid_tt") is not valid. Copy it again.');
  return [...found].map(([name, value]) => ({ name, value }));
}
