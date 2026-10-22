import { createHash } from 'node:crypto';

/**
 * The normalized shape every capture path (network frames, IM API answers, the page's DOM) is mapped to before it
 * reaches the database. Nothing here is TikTok-specific in its spelling: the mapper (mapper.ts) turns whatever
 * TikTok's web client sends into these records, and (ingest.ts) encrypts and stores them.
 */

export interface TtUser {
  /** TikTok user id (numeric string) — the `uid` TikTok uses in messages. */
  id: string;
  username?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  verified?: boolean;
}

export interface TtThread {
  /** Conversation id: our chat id. */
  id: string;
  kind: 'user' | 'group';
  /** The other person's user id (one-to-one conversations). */
  peerId?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  lastTs?: number | null;
  /** The preview line of the last message (untrusted text, stored as a message body when it is all we have). */
  lastText?: string | null;
  unread?: number;
  pinned?: boolean;
  muted?: boolean;
  /** TikTok's folder name when it is not the main inbox (e.g. "message requests"). */
  folder?: string | null;
  members?: TtUser[];
}

export type TtMediaKind = 'image' | 'video' | 'audio' | 'sticker' | 'file';

export interface TtMedia {
  /** Signed CDN URL: a bearer link to a private file. Memory only, never stored. */
  url: string;
  kind: TtMediaKind;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  thumbUrl?: string | null;
  /** AES-256-GCM key (hex) of a private photo: the CDN serves it encrypted. Memory only. */
  decryptKey?: string | null;
}

export interface TtReaction {
  senderId: string;
  emoji: string;
  ts?: number;
  removed?: boolean;
}

export interface TtMessage {
  /** Our message id: TikTok's server id when known, else `srv:<hash>` (stable for the same content). */
  id: string;
  /** TikTok's own id when [id] had to be synthesized. */
  altId?: string | null;
  threadId: string;
  senderId: string | null;
  fromMe: boolean;
  /** Epoch ms. */
  ts: number;
  /** text | media | sticker | shared_post | system | unsupported (+ whatever TikTok named it, sanitized). */
  type: string;
  text?: string | null;
  media?: TtMedia[];
  quotedId?: string | null;
  reactions?: TtReaction[];
  edited?: boolean;
  expiresAt?: number | null;
  viewOnce?: boolean;
  forwarded?: boolean;
  /** Small extra facts worth keeping (share card title, sticker name, unknown type name). Encrypted. */
  meta?: Record<string, unknown> | null;
  /** Where it came from; a live/network record wins over a DOM row for the same content. */
  source: 'history' | 'live' | 'dom' | 'sent';
}

/** Stable key for "this is the same message", used to merge a DOM row with the later network record. */
export function dedupeKey(m: { threadId: string; senderId: string | null; ts: number; text?: string | null; media?: TtMedia[]; type: string }): string {
  const body = m.text != null && m.text !== '' ? m.text : '';
  const media = (m.media ?? []).map((x) => x.url.split('?')[0]).join(',');
  return createHash('sha256').update(`${m.threadId}|${m.senderId ?? ''}|${Math.round(m.ts / 1000)}|${m.type}|${body}|${media}`).digest('hex');
}

/** A content-derived id for messages TikTok's answers did not name. */
export function syntheticId(key: string): string {
  return `srv:${createHash('sha256').update(key).digest('base64url').slice(0, 22)}`;
}

export const isSyntheticId = (id: string): boolean => id.startsWith('srv:');

/** TikTok ids: digits (user ids), or opaque conversation/message ids (letters, digits, _ - : .). */
export const isUserId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,24}$/.test(v);
export const isOpaqueId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_:.\-]{1,128}$/.test(v);

/** The page's own view of itself (used by the service to decide what to do, never trusted further than that). */
export interface PageSnapshot {
  state: {
    url: string;
    loggedIn: boolean;
    threadId: string | null;
    name: string | null;
  };
}

/** What the messages pane showed at one moment. */
export interface ThreadSnapshot {
  threadId: string | null;
  name: string | null;
  rows: import('./mapper.js').DomRow[];
  error: string | null;
  at: number;
}

/** Milliseconds since epoch for a timestamp in seconds, ms or µs (TikTok uses all three). */
export function toMillis(v: unknown, now = Date.now()): number | null {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && /^\d{9,19}$/.test(v)) n = Number(v);
  else if (typeof v === 'bigint') n = Number(v);
  if (n === null || !Number.isFinite(n)) return null;
  if (n > 1e15) n = n / 1e3; // microseconds
  else if (n > 1e11 && n < 1e15) {
    /* already milliseconds */
  } else if (n > 1e8 && n <= 1e11) n = n * 1e3; // seconds
  if (n < 1e11 || n > now + 366 * 86400_000) return null;
  return Math.round(n);
}
