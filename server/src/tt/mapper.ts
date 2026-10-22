import { createHash } from 'node:crypto';
import { dedupeKey, isOpaqueId, isUserId, syntheticId, toMillis, type TtMedia, type TtMessage, type TtReaction, type TtThread, type TtUser } from './types.js';

/**
 * Maps *whatever* TikTok sent (a JSON object out of an IM API answer, an object recovered from a WebSocket
 * frame, or the page's DOM rows) to the normalized records in types.ts.
 *
 * TikTok does not publish this format and changes it without notice, so every field is optional and every name is
 * looked up in several spellings. The mapper's job is to be boring and defensive: it returns null rather than
 * guessing, and it never lets a record through without an id, a timestamp and something to show.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First present (non-null, non-undefined, non-empty-string) value among [keys], walking dotted paths. */
export function pick(o: unknown, ...keys: string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) {
    let cur: unknown = o;
    for (const part of k.split('.')) {
      if (!isObj(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

export function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d{1,19}$/.test(v)) return Number(v);
  return null;
}

const asObjArray = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : []);

export interface MapContext {
  /** The logged-in account's TikTok user id, when known. */
  meId: string | null;
  now?: number;
}

const TEXT_MAX = 20_000;

function cleanText(s: string | null): string | null {
  if (s === null) return null;
  if (s.length > TEXT_MAX) return s.slice(0, TEXT_MAX);
  return s;
}

/* ------------------------------------------------------------------ users */

/** A user object in any of the shapes TikTok uses (sender, from_user, author, user). */
export function mapUser(o: unknown): TtUser | null {
  if (typeof o === 'string' || typeof o === 'number') {
    const id = str(o);
    return id && isUserId(id) ? { id } : null;
  }
  if (!isObj(o)) return null;
  const id =
    str(pick(o, 'user_id', 'userId', 'uid', 'id', 'from_uid', 'fromUid', 'author_id', 'authorId', 'sec_uid')) ?? null;
  const username = str(pick(o, 'unique_id', 'uniqueId', 'username', 'user_name', 'userName', 'handle', 'nickname_id'));
  const name = str(pick(o, 'nickname', 'nick_name', 'nickName', 'name', 'display_name', 'displayName'));
  const avatar =
    str(pick(o, 'avatar_thumb.url_list.0', 'avatar_medium.url_list.0', 'avatar_larger.url_list.0', 'avatar_url', 'avatarUrl', 'avatar', 'profile_pic_url')) ??
    firstUrl(pick(o, 'avatar_thumb', 'avatar', 'avatar_url'));
  if (!id || !isUserId(id.replace(/^u/, ''))) return null;
  const uid = id.replace(/^u/, '');
  return {
    id: uid,
    username: username ? username.replace(/^@/, '') : null,
    name,
    avatarUrl: avatar,
    verified: pick(o, 'verified', 'is_verified', 'custom_verify') === true || typeof pick(o, 'custom_verify') === 'string',
  };
}

function firstUrl(v: unknown): string | null {
  if (typeof v === 'string' && /^https:\/\//.test(v)) return v;
  if (Array.isArray(v)) for (const x of v) {
    const u = firstUrl(x);
    if (u) return u;
  }
  if (isObj(v)) {
    const direct = pick(v, 'url', 'src', 'uri');
    const u = typeof direct === 'string' && /^https:\/\//.test(direct) ? direct : firstUrl(pick(v, 'url_list', 'urlList'));
    if (u) return u;
  }
  return null;
}

/* ------------------------------------------------------------------ media */

const MIME_BY_KIND: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', sticker: 'image/webp' };

/** Pulls media references out of a message object (TikTok nests them as image/video/audio objects with url lists). */
export function mapMedia(o: Obj): TtMedia[] {
  const out: TtMedia[] = [];
  const seen = new Set<string>();
  const push = (url: string | null, kind: TtMedia['kind'], extra: Partial<TtMedia> = {}) => {
    if (!url || !/^https:\/\//i.test(url) || seen.has(url)) return;
    if (out.length >= 10) return;
    seen.add(url);
    out.push({ url, kind, ...extra });
  };

  const containers: [string, TtMedia['kind']][] = [
    ['image', 'image'],
    ['image_content', 'image'],
    ['sticker', 'sticker'],
    ['video', 'video'],
    ['video_content', 'video'],
    ['audio', 'audio'],
    ['voice', 'audio'],
    ['file', 'file'],
  ];
  for (const [key, kind] of containers) {
    for (const c of asObjArray(pick(o, key, `${key}s`))) {
      const url = firstUrl(pick(c, 'url_list', 'urlList', 'url', 'src', 'origin_url')) ?? firstUrl(c);
      const thumb = firstUrl(pick(c, 'thumb', 'cover', 'thumbnail', 'preview'));
      push(url, kind, {
        mime: str(pick(c, 'mime_type', 'mimeType', 'mime', 'format')) ?? MIME_BY_KIND[kind] ?? null,
        width: num(pick(c, 'width', 'w')) ?? null,
        height: num(pick(c, 'height', 'h')) ?? null,
        durationMs: num(pick(c, 'duration', 'duration_ms', 'durationMs')) ?? null,
        thumbUrl: thumb,
      });
    }
  }
  // A bare attachment list, or a single media-ish object.
  for (const c of asObjArray(pick(o, 'attachments', 'media', 'contents'))) {
    const url = firstUrl(pick(c, 'url_list', 'urlList', 'url', 'src')) ?? firstUrl(c);
    const kindName = (str(pick(c, 'type', 'kind', 'media_type', 'content_type')) ?? '').toLowerCase();
    const kind: TtMedia['kind'] = kindName.includes('video') ? 'video' : kindName.includes('audio') || kindName.includes('voice') ? 'audio' : kindName.includes('sticker') ? 'sticker' : 'image';
    push(url, kind, {
      mime: str(pick(c, 'mime_type', 'mime', 'format')) ?? MIME_BY_KIND[kind] ?? null,
      width: num(pick(c, 'width')) ?? null,
      height: num(pick(c, 'height')) ?? null,
      thumbUrl: firstUrl(pick(c, 'thumb', 'cover', 'thumbnail')),
    });
  }
  return out;
}

/* --------------------------------------------------------------- messages */

/**
 * True when this object is worth treating as a message at all: it needs a timestamp. An id is *not* required — a push
 * frame may omit it — because a record with a conversation, a time and something to show is exactly what the DOM path
 * stores too (under a content-derived id, which the network record later merges into).
 */
function looksLikeMessage(o: Obj): boolean {
  return pick(o, 'create_time', 'createTime', 'created_at', 'createdAt', 'timestamp', 'send_time', 'sendTime', 'ts', 'time') !== undefined;
}

const CONTENT_KEYS = ['content', 'text', 'body', 'message', 'msg_content', 'rich_text', 'desc'];

/** The human-readable text of a message object: TikTok puts JSON inside `content` for text messages. */
function messageText(o: Obj): string | null {
  for (const key of CONTENT_KEYS) {
    const v = pick(o, key);
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{')) {
        try {
          const inner = JSON.parse(t) as Obj;
          const it = pick(inner, 'text', 'content', 'desc', 'title');
          if (typeof it === 'string' && it.length) return cleanText(it);
          // A share card or a sticker: no plain text.
          return null;
        } catch {
          /* not JSON: use it as text */
        }
      }
      if (t.length) return cleanText(v);
    } else if (isObj(v)) {
      const it = pick(v, 'text', 'content', 'body', 'desc');
      if (typeof it === 'string' && it.length) return cleanText(it);
    }
  }
  return null;
}

/**
 * The JSON inside `content` when TikTok sent it as a string — the shape both the IM API answers and the socket frames
 * use (`{"aweType":800,"itemId":…}`). Reading only `o.content.aweType` missed it and a shared video came out as an
 * unreadable message.
 */
function contentObject(o: Obj): Obj {
  for (const key of CONTENT_KEYS) {
    const v = pick(o, key);
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        return JSON.parse(v) as Obj;
      } catch {
        /* not JSON: nothing to read */
      }
    } else if (isObj(v)) return v;
  }
  return {};
}

const TYPE_BY_AWE: Record<string, string> = {
  '700': 'text',
  '500': 'sticker',
  '1': 'text',
  '7': 'text',
  '8': 'shared_post',
  '71': 'shared_post',
  '76': 'shared_post',
  '800': 'shared_post',
};

/** Maps one candidate object to a message, or null when it is not one (or lacks what we need to store it). */
export function mapMessage(o: unknown, chatHint: string | null, ctx: MapContext): TtMessage | null {
  if (!isObj(o) || !looksLikeMessage(o)) return null;
  const now = ctx.now ?? Date.now();

  const threadId =
    str(pick(o, 'conversation_id', 'conversationId', 'conv_id', 'thread_id', 'threadId', 'chat_id', 'chatId', 'cid')) ??
    (chatHint && isOpaqueId(chatHint) ? chatHint : null);
  if (!threadId || !isOpaqueId(threadId)) return null;

  const ts = toMillis(
    pick(o, 'create_time', 'createTime', 'created_at', 'createdAt', 'timestamp', 'send_time', 'sendTime', 'ts', 'time'),
    now,
  );
  if (ts === null) return null;
  // Junk with a plausible-looking id is the main risk: keep only records from a sane window.
  if (ts < now - 10 * 365 * 86400_000) return null;

  const rawId = str(pick(o, 'message_id', 'messageId', 'msg_id', 'msgId', 'server_message_id', 'serverMessageId', 'id', 'uuid'));
  const serverId = rawId && isOpaqueId(rawId) ? rawId : null;

  const senderObj = pick(o, 'sender', 'from_user', 'fromUser', 'from', 'author', 'user');
  const sender = mapUser(senderObj);
  const senderId =
    sender?.id ??
    str(pick(o, 'sender_id', 'senderId', 'from_uid', 'fromUid', 'sender_uid', 'uid', 'from_user_id'))?.replace(/^u/, '') ??
    null;
  const explicitMine = pick(o, 'is_me', 'isMe', 'from_me', 'fromMe', 'is_from_me', 'isFromMe');
  const fromMe =
    explicitMine === true || explicitMine === 1 || (typeof senderId === 'string' && ctx.meId !== null && senderId === ctx.meId);

  const media = mapMedia(o);
  let text = messageText(o);
  const typeName = (str(pick(o, 'type', 'msg_type', 'msgType', 'content_type', 'contentType')) ?? '').toLowerCase();
  const inner = contentObject(o);
  const awe = str(pick(o, 'aweType', 'awe_type')) ?? str(pick(inner, 'aweType', 'awe_type'));
  let type: string;
  if (typeName) type = /^[a-z0-9_.-]{1,32}$/.test(typeName) ? typeName : 'unknown';
  else if (media.length) type = media[0]!.kind === 'sticker' ? 'sticker' : 'media';
  else if (text !== null) type = 'text';
  else if (awe && TYPE_BY_AWE[awe]) type = TYPE_BY_AWE[awe]!;
  else type = 'unsupported';
  if (type === 'text' && text === null && media.length === 0) type = 'unsupported';
  if (media.length && type === 'text') type = 'media';
  if (awe === '500' && media.length) type = 'sticker';
  if (!text && media.length === 0 && (type === 'text' || type === 'media')) return null;

  const quotedRaw = pick(o, 'ref_message_id', 'refMessageId', 'quoted_id', 'quotedId', 'reply_to', 'replyTo', 'reply_message_id');
  const quotedId = str(quotedRaw) && isOpaqueId(str(quotedRaw)) ? str(quotedRaw) : null;

  const reactions: TtReaction[] = [];
  for (const r of asObjArray(pick(o, 'reactions', 'reaction_list'))) {
    const emoji = str(pick(r, 'emoji', 'text', 'reaction', 'icon'));
    const who = mapUser(pick(r, 'sender', 'user', 'from_user'))?.id ?? str(pick(r, 'sender_id', 'uid', 'user_id'));
    if (!emoji || !who) continue;
    reactions.push({ senderId: who, emoji, ts: toMillis(pick(r, 'create_time', 'timestamp', 'ts'), now) ?? ts });
  }

  const key = dedupeKey({ threadId, senderId, ts, text, media, type });
  const id = serverId ?? syntheticId(key);
  const meta: Obj = {};
  const shareTitle = str(pick(o, 'share_title', 'shareTitle', 'card_title', 'title')) ?? str(pick(inner, 'content_title', 'content_name', 'title'));
  if (shareTitle) meta.shareTitle = shareTitle;
  // A shared post captured from a socket frame: the card needs TikTok's post id to be playable in the chat.
  const itemId = str(pick(o, 'itemId', 'item_id', 'aweme_id')) ?? str(pick(inner, 'itemId', 'item_id', 'aweme_id'));
  if (itemId && /^\d{6,24}$/.test(itemId)) {
    meta.itemId = itemId;
    meta.url = `https://www.tiktok.com/@_/video/${itemId}`;
  }
  if (awe) meta.aweType = awe;
  if (text === null && media.length === 0) meta.unreadable = true;
  if (shareTitle || awe || meta.unreadable) meta.dedupeKey = key;

  return {
    id,
    altId: serverId ? null : null,
    threadId,
    senderId,
    fromMe,
    ts,
    type,
    text,
    media,
    quotedId,
    reactions: reactions.length ? reactions : undefined,
    edited: pick(o, 'is_edited', 'edited', 'edit_time') !== undefined && pick(o, 'edit_time', 'is_edited') !== null,
    expiresAt: toMillis(pick(o, 'expire_at', 'expireAt', 'expires_at', 'ttl'), now),
    viewOnce: pick(o, 'is_view_once', 'viewOnce') === true,
    forwarded: pick(o, 'is_forwarded', 'forwarded') === true,
    meta: Object.keys(meta).length ? meta : null,
    source: 'live',
  };
}

/* ---------------------------------------------------------------- threads */

/** Maps an IM API conversation object. */
export function mapThread(o: unknown, ctx: MapContext): TtThread | null {
  if (!isObj(o)) return null;
  const now = ctx.now ?? Date.now();
  const id = str(pick(o, 'conversation_id', 'conversationId', 'conv_id', 'thread_id', 'threadId', 'chat_id', 'chatId', 'cid', 'id'));
  if (!id || !isOpaqueId(id)) return null;

  const peerObj = pick(o, 'participants.0', 'peer_user', 'peerUser', 'user', 'peer', 'to_user', 'other_user');
  const peer = mapUser(peerObj);
  const lastObj = pick(o, 'last_message', 'lastMessage', 'latest_message', 'lastMessageInfo');
  const lastTs =
    toMillis(pick(o, 'last_message_time', 'lastMessageTime', 'updated_at', 'update_time', 'last_ts', 'lastTs'), now) ??
    (isObj(lastObj) ? toMillis(pick(lastObj, 'create_time', 'createdAt', 'timestamp'), now) : null);
  const previewSource = isObj(lastObj) ? lastObj : o;
  const lastText = messageText(previewSource);
  const name = str(pick(o, 'name', 'title', 'conversation_name', 'nickname')) ?? peer?.name ?? peer?.username ?? null;
  const avatar = str(pick(o, 'avatar_url', 'avatarUrl', 'icon')) ?? peer?.avatarUrl ?? null;
  const unread = num(pick(o, 'unread_count', 'unreadCount', 'unread', 'badge_count')) ?? undefined;
  const kind = pick(o, 'is_group', 'isGroup') === true || (num(pick(o, 'participant_count', 'member_count')) ?? 0) > 2 ? 'group' : 'user';

  return {
    id,
    kind,
    peerId: peer?.id ?? str(pick(o, 'peer_id', 'peerId', 'to_uid', 'peer_uid')) ?? null,
    name,
    avatarUrl: avatar,
    lastTs: lastTs ?? null,
    lastText,
    unread: unread === undefined ? undefined : unread,
    pinned: pick(o, 'pinned', 'is_pinned', 'isPinned', 'sticky') === true,
    muted: pick(o, 'muted', 'is_muted', 'isMuted') === true,
  };
}

/* ----------------------------------------------------------------- the DOM */

/** A message row read from the page (dom.ts). Text only unless the row carried a media URL. */
export interface DomRow {
  /** Index in the list (for ordering when no id/time is present). */
  i: number;
  id?: string | null;
  text?: string | null;
  mine?: boolean;
  /** Milliseconds, when the row showed a time; else null. */
  ts?: number | null;
  media?: { url?: string | null; kind?: string | null }[];
  /** "Message deleted" system line TikTok renders in place of a removed message. */
  deleted?: boolean;
  system?: boolean;
  /** Sender name/username shown above the row (group chats). */
  senderName?: string | null;
  senderId?: string | null;
  quotedText?: string | null;
}

export function domRowToMessage(threadId: string, row: DomRow, ctx: MapContext): TtMessage | null {
  if (row.system || row.deleted) {
    const now = ctx.now ?? Date.now();
    const ts = row.ts ?? now;
    const text = row.text ?? 'Message deleted';
    const key = dedupeKey({ threadId, senderId: null, ts, text, media: [], type: 'system' });
    return {
      id: syntheticId(key),
      threadId,
      senderId: null,
      fromMe: false,
      ts,
      type: 'system',
      text: cleanText(text),
      media: [],
      source: 'dom',
    };
  }
  const media: TtMedia[] = [];
  for (const m of row.media ?? []) {
    const url = m?.url ?? null;
    if (!url || !/^https:\/\//i.test(url) || media.some((x) => x.url === url)) continue;
    const kind = (m?.kind ?? '').toLowerCase();
    media.push({ url, kind: kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image' });
  }
  let text = row.text ? cleanText(row.text) : null;
  if (text && media.length && /^\d{1,2}:\d{2}(\s*(am|pm))?$/i.test(text.trim())) text = null;
  if (!text && media.length === 0) return null;
  const ts = row.ts ?? (ctx.now ?? Date.now());
  const senderId = row.mine ? (ctx.meId ?? null) : (row.senderId ?? null);
  const type = media.length ? (media[0]!.kind === 'video' ? 'media' : 'media') : 'text';
  const key = dedupeKey({ threadId, senderId: row.mine ? (ctx.meId ?? 'me') : senderId, ts, text, media, type });
  const serverId = row.id && isOpaqueId(row.id) ? row.id : null;
  return {
    id: serverId ?? syntheticId(key),
    altId: null,
    threadId,
    senderId,
    fromMe: !!row.mine,
    ts,
    type,
    text,
    media,
    quotedId: null,
    source: 'dom',
    meta: row.senderName ? { senderName: row.senderName } : null,
  };
}

/** A conversation row read from the page's thread list. */
export interface DomThread {
  id?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  lastText?: string | null;
  lastTs?: number | null;
  unread?: number | null;
  pinned?: boolean;
  muted?: boolean;
}

export function domThreadToThread(t: DomThread, ctx: MapContext): TtThread | null {
  const name = t.name?.trim() || null;
  const id = t.id && isOpaqueId(t.id) ? t.id : name ? `nm:${createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 20)}` : null;
  if (!id) return null;
  return {
    id,
    kind: 'user',
    name,
    avatarUrl: t.avatarUrl ?? null,
    lastTs: t.lastTs ?? null,
    lastText: t.lastText ?? null,
    unread: t.unread ?? undefined,
    pinned: t.pinned,
    muted: t.muted,
  };
}

/* ------------------------------------------------------------- JSON walking */

/**
 * Every object in a JSON answer that could be a conversation or a message (bounded breadth-first walk). Used on
 * whole API answers, where the records sit in arrays under keys nobody promised us.
 */
export function walkCandidates(root: unknown, limit = 400): Obj[] {
  const out: Obj[] = [];
  const queue: unknown[] = [root];
  let guard = 0;
  while (queue.length && out.length < limit && guard++ < 5000) {
    const cur = queue.shift();
    if (Array.isArray(cur)) {
      for (const x of cur.slice(0, 200)) queue.push(x);
      continue;
    }
    if (!isObj(cur)) continue;
    out.push(cur);
    for (const v of Object.values(cur)) {
      if (Array.isArray(v) || isObj(v)) queue.push(v);
    }
  }
  return out;
}
