import { allBytes, bytesOf, lz4Block, num, PbWriter, readFields, str, sub, subs, type Field } from './wire.js';

/**
 * TikTok web IM requests and answers (reverse-engineered; field numbers follow matrix-tiktok's im.proto, checked
 * against the live answers). Only what the logger needs: the conversation list, history, sending text, marking read,
 * and the socket's chat / recall / receipt events.
 */

export const IM_AID = '1988';
const CLIENT_VERSION = '1.6.0';

/** What the page knows about itself and the browser: sent back to TikTok as the client would send it. */
export interface ImEnv {
  deviceId: string;
  msToken: string;
  verifyFp: string;
  userAgent: string;
  language: string;
  platform: string;
  tz: string;
  region: string;
  screenW: number;
  screenH: number;
  historyLen: number;
}

type KV = [string, string];

export function metadata(env: ImEnv, extra: KV[] = []): KV[] {
  const pairs: KV[] = [
    ['aid', IM_AID],
    ['app_name', 'tiktok_web'],
    ['channel', 'web'],
    ['device_platform', 'web_pc'],
    ['device_id', env.deviceId],
    ['region', env.region],
    ['priority_region', env.region],
    ['os', /mac/i.test(env.platform) ? 'mac' : /win/i.test(env.platform) ? 'windows' : 'linux'],
    ['referer', 'https://www.tiktok.com/messages'],
    ['root_referer', ''],
    ['cookie_enabled', 'true'],
    ['screen_width', String(env.screenW)],
    ['screen_height', String(env.screenH)],
    ['browser_language', env.language],
    ['browser_platform', env.platform],
    ['browser_name', 'Mozilla'],
    // The web client mirrors the whole UA string here, not only the version.
    ...extra,
    ['browser_version', env.userAgent],
    ['browser_online', 'true'],
  ];
  if (env.verifyFp) pairs.push(['verifyFp', env.verifyFp]);
  pairs.push(
    ['app_language', env.language.split('-')[0] ?? 'en'],
    ['webcast_language', env.language.split('-')[0] ?? 'en'],
    ['tz_name', env.tz],
    ['is_page_visible', 'true'],
    ['focus_state', 'true'],
    ['is_fullscreen', 'false'],
    ['history_len', String(env.historyLen)],
    ['user_is_login', 'true'],
    ['data_collection_enabled', 'true'],
    ['from_appID', IM_AID],
    ['locale', env.language.split('-')[0] ?? 'en'],
    ['user_agent', env.userAgent],
  );
  if (env.msToken) pairs.push(['Web-Sdk-Ms-Token', env.msToken]);
  return pairs;
}

interface Envelope {
  clientVersion?: string;
  gitHash?: string;
  type: number;
  sub: number;
  reserved6: number;
  /** field number of the typed payload wrapper, and its body */
  payloadField: number;
  body: PbWriter;
  deviceId?: string;
  meta: KV[];
}

function envelope(e: Envelope): Buffer {
  const w = new PbWriter()
    .u64(1, e.type)
    .u64(2, e.sub)
    .string(3, e.clientVersion ?? CLIENT_VERSION)
    .message(4, Buffer.alloc(0))
    .u64(5, 3)
    .u64(6, e.reserved6)
    .string(7, e.gitHash ?? '')
    .message(8, new PbWriter().message(e.payloadField, e.body));
  if (e.deviceId !== undefined) w.string(9, e.deviceId);
  w.string(11, 'web');
  for (const [k, v] of e.meta) w.message(15, new PbWriter().string(1, k).string(2, v));
  w.u64(18, 1);
  return w.build();
}

/* ------------------------------------------------------------------ requests */

export const INBOX_PATH = '/v2/message/get_by_user_init';
export const HISTORY_PATH = '/v1/message/get_by_conversation';
export const COMBO_PATH = '/v1/message/get_by_user_combo';
export const SEND_PATH = '/v1/message/send';
export const MARK_READ_PATH = '/v3/conversation/mark_read';

/** The conversation list. `kind` 10002 returns group chats, 10006 the one-to-one ones (the web client asks for both). */
export function buildInboxRequest(env: ImEnv, kind: 10002 | 10006, cursor = '0', extra: { limit?: number; conType?: number; cursorField?: number } = {}): Buffer {
  const body = new PbWriter().u64(1, 0);
  if (cursor !== '0') body.u64(extra.cursorField ?? 2, BigInt(cursor));
  if (extra.conType !== undefined) body.u64(3, extra.conType);
  if (extra.limit !== undefined) body.u64(4, extra.limit);
  return envelope({
    type: 203,
    sub: kind,
    reserved6: kind === 10006 ? 0 : 1,
    payloadField: 203,
    body,
    deviceId: env.deviceId,
    meta: metadata(env),
  });
}

/**
 * The paged conversation list the current web client uses (type 204): two lanes (0 and 1), each from a µs cursor, up to
 * `limit` rows per page. The old `get_by_user_init` still answers but only ever returns the ten newest chats.
 */
export function buildComboRequest(env: ImEnv, cursors: [string, string], limit = 50, gitHash = '0120411:master'): Buffer {
  const lane = (kind: number, cursor: string) => new PbWriter().u64(1, kind).u64(2, BigInt(cursor || '0')).u64(3, limit).u64(4, 8);
  const body = new PbWriter().message(1, lane(0, cursors[0])).message(1, lane(1, cursors[1]));
  return envelope({ clientVersion: '1.8.3', gitHash, type: 204, sub: 10074, reserved6: 0, payloadField: 204, body, deviceId: env.deviceId, meta: metadata(env) });
}

/** One page of a conversation, newest first. `cursorUs` 0 = the latest page. */
export function buildHistoryRequest(env: ImEnv, convId: string, sourceId: string, cursorUs: string, count: number): Buffer {
  return envelope({
    type: 301,
    sub: 1,
    reserved6: 0,
    payloadField: 301,
    body: new PbWriter().string(1, convId).u64(2, 1).u64(3, BigInt(sourceId || '0')).u64(4, 1).u64(5, BigInt(cursorUs || '0')).u64(6, count),
    meta: metadata(env),
  });
}

export interface SendArgs {
  convId: string;
  sourceId: string;
  isGroup: boolean;
  text: string;
  clientMessageId: string;
  publicKeyB64: string;
}

export function buildSendRequest(env: ImEnv, a: SendArgs): Buffer {
  const tags = [
    new PbWriter().string(1, 's:mentioned_users'),
    new PbWriter().string(1, 's:client_message_id').bytes(2, Buffer.from(a.clientMessageId)),
  ];
  const body = new PbWriter()
    .string(1, a.convId)
    .u64(2, a.isGroup ? 2 : 1)
    .u64(3, BigInt(a.sourceId || '0'))
    .bytes(4, Buffer.from(JSON.stringify({ aweType: 0, text: a.text })));
  for (const t of tags) body.message(5, t);
  body.u64(6, 7).string(7, 'deprecated').string(8, a.clientMessageId);
  // The web client puts the ticket-guard entries right before browser_version.
  const meta = metadata(env, [
    ['tt-ticket-guard-public-key', a.publicKeyB64],
    ['tt-ticket-guard-client-data', ''],
    ['tt-ticket-guard-version', '2'],
    ['tt-ticket-guard-iteration-version', '0'],
    ['tt-ticket-guard-web-version', '1'],
  ]);
  return envelope({ type: 100, sub: a.isGroup ? 10014 : 10009, reserved6: a.isGroup ? 1 : 0, payloadField: 100, body, deviceId: env.deviceId, meta });
}

export interface MarkReadArgs {
  convId: string;
  sourceId: string;
  convType: number;
  /** timestamp (µs) of the newest message */
  readIndex: string;
}

export function buildMarkReadRequest(env: ImEnv, a: MarkReadArgs): Buffer {
  const body = new PbWriter().string(1, a.convId).u64(2, BigInt(a.sourceId || '0')).u64(3, a.convType).u64(4, BigInt(a.readIndex || '0')).u64(5, 0).u64(6, 0);
  return envelope({ type: 604, sub: 1, reserved6: 0, payloadField: 604, body, deviceId: env.deviceId, meta: metadata(env) });
}

/* ------------------------------------------------------------------- answers */

export interface ImConversation {
  id: string;
  sourceId: string;
  /** 1 = one-to-one, 2 = group (TikTok's own numbers) */
  type: number;
  lastTsUs: string;
  title: string | null;
  avatarUrl: string | null;
  members: string[];
}

export interface ImInbox {
  conversations: ImConversation[];
  /** µs cursor of the next page, '' when this was the last */
  nextCursor: string;
  hasMore: boolean;
}

export function parseInbox(body: Buffer): ImInbox {
  const top = readFields(body);
  const payload = sub(top, 6);
  const list = payload ? sub(payload, 203) : null;
  if (!list) return { conversations: [], nextCursor: '', hasMore: false };
  const byId = new Map<string, ImConversation>();
  const get = (id: string): ImConversation => {
    let c = byId.get(id);
    if (!c) byId.set(id, (c = { id, sourceId: '', type: 0, lastTsUs: '0', title: null, avatarUrl: null, members: [] }));
    return c;
  };
  for (const d of subs(list, 2)) {
    const id = str(d, 1);
    if (!id) continue;
    const c = get(id);
    c.sourceId = num(d, 2) || c.sourceId;
    c.type = Number(num(d, 3)) || c.type;
    const members = sub(d, 6);
    if (members) for (const m of subs(members, 1)) {
      const uid = num(m, 1);
      if (uid && !c.members.includes(uid)) c.members.push(uid);
    }
    const core = sub(d, 50);
    if (core) {
      c.title = str(core, 5) || c.title;
      c.avatarUrl = str(core, 7) || c.avatarUrl;
    }
    const state = sub(d, 51);
    if (state) c.lastTsUs = num(state, 5) || c.lastTsUs;
  }
  for (const e of subs(list, 1)) {
    const id = str(e, 1);
    if (!id) continue;
    const c = get(id);
    c.type = Number(num(e, 2)) || c.type;
    c.sourceId = num(e, 5) || c.sourceId;
    const ts = num(e, 4);
    if (ts && BigInt(ts) > BigInt(c.lastTsUs)) c.lastTsUs = ts;
  }
  const out = [...byId.values()];
  for (const c of out) if (!c.type) c.type = c.id.startsWith('0:1:') ? 1 : 2;
  const hasMore = num(list, 5) === '1';
  return { conversations: out, nextCursor: hasMore ? num(list, 3) : '', hasMore };
}

export interface ImTag {
  key: string;
  value: Buffer;
}

export interface ImMedia {
  kind: 'image' | 'video' | 'sticker';
  url: string;
  thumbUrl: string | null;
  decryptKey: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface ImMessage {
  convId: string;
  serverId: string;
  tsUs: string;
  senderId: string;
  content: Buffer;
  tags: ImTag[];
  subtype: string;
  clientMessageId: string;
  recalled: boolean;
  reactions: { key: string; userIds: string[] }[];
  replyToServerId: string | null;
  media: ImMedia | null;
  cursorUs: string;
  /** the conversation's short id (field 5 of a combo row) */
  sourceId: string;
}

function readTags(fs: Field[], n: number): ImTag[] {
  return subs(fs, n).map((t) => ({ key: str(t, 1), value: Buffer.from(bytesOf(t, 2) ?? Buffer.alloc(0)) }));
}

function privateMedia(subtype: string, att: Field[]): ImMedia | null {
  const key = str(att, 3) || null;
  const variants = subs(att, 20).map((v) => ({
    label: (bytesOf(v, 1) ?? Buffer.alloc(0)).toString('latin1').toLowerCase(),
    url: allBytes(v, 2).map((b) => b.toString('utf8')).find((u) => u) ?? '',
    w: Number(num(v, 20)) || null,
    h: Number(num(v, 21)) || null,
    d: Number(num(v, 22)) || null,
  })).filter((v) => v.url);
  if (!variants.length) return null;
  const has = (v: (typeof variants)[number], ...needles: string[]) => needles.some((x) => v.label.includes(x) || v.url.toLowerCase().includes(x));
  if (/video/i.test(subtype)) {
    const play = variants.find((v) => has(v, 'play', 'mime_type=video_')) ?? variants[0]!;
    const cover = variants.find((v) => has(v, 'cover', 'tplv-noop.image')) ?? play;
    return { kind: 'video', url: play.url, thumbUrl: cover.url, decryptKey: null, width: play.w ?? cover.w, height: play.h ?? cover.h, durationMs: play.d };
  }
  const full = variants.find((v) => has(v, 'full', 'default.image')) ?? variants[0]!;
  const thumb = variants.find((v) => has(v, 'view', 'thumb.image')) ?? full;
  return { kind: 'image', url: full.url, thumbUrl: thumb.url, decryptKey: key, width: full.w ?? thumb.w, height: full.h ?? thumb.h, durationMs: null };
}

function stickerMedia(att: Field[]): { media: ImMedia; label: string } | null {
  const st = sub(att, 7);
  const asset = st ? sub(st, 1) : null;
  const url = asset ? str(asset, 2) : '';
  if (!url) return null;
  const size = asset ? sub(asset, 5) : null;
  const texts = st ? sub(st, 2) : null;
  let label = '';
  for (const n of [3, 2, 1]) {
    const t = texts ? sub(texts, n) : null;
    if (t && str(t, 1)) {
      label = str(t, 1);
      break;
    }
  }
  return {
    media: { kind: 'sticker', url, thumbUrl: null, decryptKey: null, width: size ? Number(num(size, 1)) || null : null, height: size ? Number(num(size, 2)) || null : null, durationMs: null },
    label,
  };
}

/** A history row or a socket chat detail (same field numbers for everything we read). */
function readMessage(convId: string, fs: Field[]): ImMessage {
  const tags = readTags(fs, 9);
  const tag = (k: string) => tags.find((t) => t.key === k)?.value.toString('utf8') ?? '';
  const subtype = str(fs, 21);
  const att = sub(fs, 20);
  const priv = sub(fs, 24);
  const reply = sub(fs, 18);
  const sticker = att ? stickerMedia(att) : null;
  const media = sticker?.media ?? (priv ? privateMedia(subtype, priv) : null);
  return {
    convId,
    serverId: num(fs, 3),
    tsUs: num(fs, 4),
    senderId: num(fs, 7),
    content: Buffer.from(bytesOf(fs, 8) ?? Buffer.alloc(0)),
    tags,
    subtype,
    clientMessageId: tag('s:client_message_id'),
    recalled: tag('s:is_recalled').trim() === '1',
    reactions: subs(fs, 15).map((r) => ({
      key: str(r, 1).replace(/^e:/, ''),
      userIds: (sub(r, 2) ? subs(sub(r, 2)!, 1) : []).map((u) => num(u, 1) || str(u, 4)).filter(Boolean),
    })),
    replyToServerId: reply ? num(reply, 1) || null : null,
    media,
    cursorUs: num(fs, 25) || num(fs, 27),
    sourceId: num(fs, 5),
  };
}

export interface ImHistory {
  messages: ImMessage[];
  /** where the next (older) page starts: the oldest cursor in this page, '' when the page was empty */
  nextCursorUs: string;
  /** rows TikTok marks as unsent/invisible placeholders */
  skipped: number;
  /** server ids of messages their sender unsent (the row stays in the history as a placeholder) */
  recalledIds: string[];
}

export function parseHistory(body: Buffer): ImHistory {
  const top = readFields(body);
  const payload = sub(top, 6);
  const list = payload ? sub(payload, 301) : null;
  const rows = list ? subs(list, 1) : [];
  const messages: ImMessage[] = [];
  const recalledIds: string[] = [];
  let skipped = 0;
  let min = 0n;
  for (const r of rows) {
    const c = num(r, 25);
    if (c && c !== '0' && (min === 0n || BigInt(c) < min)) min = BigInt(c);
    const m = readMessage(str(r, 1), r);
    if (m.recalled) recalledIds.push(m.serverId);
    if (m.recalled || m.tags.some((t) => t.key === 's:invisible' && t.value.toString('utf8').trim() !== '')) {
      skipped++;
      continue;
    }
    if (m.serverId) messages.push(m);
  }
  messages.reverse(); // oldest first
  return { messages, nextCursorUs: min ? min.toString() : '', skipped, recalledIds };
}

export interface ImComboLane {
  kind: number;
  messages: ImMessage[];
  recalledIds: string[];
  hasMore: boolean;
  /** µs cursor to continue from ('' when TikTok gave none) */
  next: string;
}

/**
 * The answer of `get_by_user_combo`: per lane, the messages (oldest first) of every conversation after the cursor.
 * Conversation id, server id, time (µs), sender, JSON content and tags sit in the same fields as in a history row.
 */
export function parseCombo(body: Buffer): ImComboLane[] {
  const top = readFields(body);
  const payload = sub(top, 6);
  const list = payload ? sub(payload, 204) : null;
  if (!list) return [];
  return subs(list, 1).map((lane) => {
    const messages: ImMessage[] = [];
    const recalledIds: string[] = [];
    for (const r of subs(lane, 2)) {
      const m = readMessage(str(r, 1), r);
      if (m.recalled) recalledIds.push(m.serverId);
      else if (!m.tags.some((t) => t.key === 's:invisible' && t.value.toString('utf8').trim() !== '') && m.serverId) messages.push(m);
    }
    return { kind: Number(num(lane, 1)), messages, recalledIds, hasMore: num(lane, 4) === '1', next: num(lane, 5) };
  });
}

/**
 * The answer to a send. Field 1 echoes the request type (100) — it is NOT a status; the status is field 3 (0 = accepted),
 * the way the inbox answer has type 203 in field 1 and status 0 in field 3. (v1.7.0 read field 1 and reported every
 * accepted message as "refused, code 100".)
 */
export function parseSend(body: Buffer): { status: string; messageId: string } {
  const top = readFields(body);
  const status = num(top, 3);
  for (const n of [6, 8]) {
    const p = sub(top, n);
    const s = p ? sub(p, 100) : null;
    if (s) {
      const id = str(s, 1) || num(s, 1);
      if (id) return { status, messageId: id };
    }
  }
  return { status, messageId: '' };
}

export function parseStatus(body: Buffer): string {
  try {
    return num(readFields(body), 3);
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------- socket frames */

export type ImEvent =
  | { kind: 'message'; message: ImMessage }
  | { kind: 'recall'; convId: string; serverId: string; byUserId: string | null }
  | { kind: 'receipt'; convId: string; readerId: string | null; readServerId: string; tsUs: string }
  | { kind: 'reaction'; convId: string; serverId: string; userId: string; emoji: string; removed: boolean }
  | { kind: 'typing'; convId: string; userId: string };

/** One binary frame of `wss://im-ws-*.tiktok.com/ws/v2`: an outer envelope (maybe LZ4) around the event envelope. */
export function parseSocketFrame(data: Buffer): ImEvent | null {
  const outer = readFields(data);
  let inner = bytesOf(outer, 8);
  if (!inner || inner.length === 0) return null;
  const comp = bytesOf(outer, 6);
  if (comp && comp.toString('latin1') === '__lz4') inner = lz4Block(Buffer.from(inner));
  const env = readFields(inner);
  const type = Number(num(env, 1));
  const cmds = sub(env, 6);
  if (!type || !cmds) return null;
  if (type === 500) {
    const chat = sub(cmds, 500);
    const detail = chat ? sub(chat, 5) : null;
    const convId = chat ? str(chat, 2) : '';
    if (!chat || !detail || !convId) return null;
    const m = readMessage(convId, detail);
    const tagText = (k: string) => m.tags.find((t) => t.key === k)?.value.toString('utf8') ?? '';
    // A recall (delete for everyone) is a chat frame tagged with the recalling user; the tag names the message.
    const recallUid = tagText('s:recall_uid');
    if (recallUid) {
      const target = recallTarget(m);
      return target ? { kind: 'recall', convId, serverId: target, byUserId: recallUid } : null;
    }
    const prop = tagText('s:property_modify');
    if (prop) return reactionFrom(convId, m, prop);
    if (m.recalled || m.tags.some((t) => t.key === 's:invisible' && t.value.toString('utf8').trim() !== '')) return null;
    if (!m.serverId) return null;
    return { kind: 'message', message: m };
  }
  if (type === 501) {
    const r = sub(cmds, 501);
    if (!r) return null;
    const convId = str(r, 1);
    const readServerId = num(r, 6);
    if (!convId || !readServerId) return null;
    return { kind: 'receipt', convId, readerId: num(r, 5) || null, readServerId, tsUs: num(r, 3) };
  }
  if (type === 510) {
    const t = sub(cmds, 510);
    if (!t) return null;
    const convId = str(t, 2);
    const userId = num(t, 1);
    return convId && userId ? { kind: 'typing', convId, userId } : null;
  }
  return null;
}

function recallTarget(m: ImMessage): string {
  const v = m.tags.find((t) => t.key === 's:server_message_id')?.value.toString('utf8') ?? '';
  return /^\d{5,24}$/.test(v) ? v : '';
}

const isUnicode = (s: string) => /[^\x00-\x7f]/.test(s);

/**
 * `s:property_modify` is `{"UserId":…,"ServerMessageId":…,"Modifys":[{"Op":0,"Key":"e:❤️"},{"Op":0,"Key":"e:love"}]}`.
 * The ids are 19-digit JSON numbers: read as text, because a JS number would round them.
 */
function reactionFrom(convId: string, m: ImMessage, prop: string): ImEvent | null {
  try {
    const j = JSON.parse(prop) as { Modifys?: { Op?: number; Key?: string }[] };
    const bigId = (name: string) => new RegExp(`"${name}"\\s*:\\s*"?(\\d{5,24})`).exec(prop)?.[1] ?? '';
    const idTag = m.tags.find((t) => t.key === 's:server_message_id')?.value.toString('utf8') ?? '';
    const serverId = bigId('ServerMessageId') || idTag;
    // TikTok sends every reaction twice (the glyph and its alias): prefer the glyph.
    const mods = (j.Modifys ?? []).filter((x) => typeof x.Key === 'string' && x.Key.replace(/^e:/, ''));
    const mod = mods.find((x) => isUnicode(x.Key!)) ?? mods[0];
    if (!serverId || !mod) return null;
    return { kind: 'reaction', convId, serverId, userId: bigId('UserId') || m.senderId, emoji: mod.Key!.replace(/^e:/, ''), removed: mod.Op === 1 };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ content */

export interface Content {
  type: 'text' | 'shared_post' | 'media' | 'sticker' | 'unsupported';
  text: string | null;
  meta: Record<string, unknown> | null;
}

/** The JSON body of a message: `{"aweType":700,"text":"…"}` and friends. */
export function parseContent(m: Pick<ImMessage, 'content' | 'media' | 'subtype'>): Content {
  if (m.media) {
    const label = m.media.kind === 'video' ? '[video]' : m.media.kind === 'sticker' ? '[sticker]' : '[photo]';
    return { type: m.media.kind === 'sticker' ? 'sticker' : 'media', text: null, meta: m.media.kind === 'sticker' ? { label } : null };
  }
  let j: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(m.content.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) j = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!j) return { type: 'unsupported', text: null, meta: null };
  const awe = typeof j.aweType === 'number' ? j.aweType : typeof j.aweType === 'string' ? Number(j.aweType) : NaN;
  const text = typeof j.text === 'string' ? j.text : null;
  if (awe === 0 || awe === 700 || awe === 703) return { type: 'text', text, meta: null };
  if (awe === 800) {
    const itemId = typeof j.itemId === 'string' ? j.itemId : null;
    const title = typeof j.content_title === 'string' ? j.content_title : null;
    return { type: 'shared_post', text: title, meta: { itemId, uid: typeof j.uid === 'string' ? j.uid : null, ...(itemId ? { url: `https://www.tiktok.com/@_/video/${itemId}` } : {}) } };
  }
  if (Number.isFinite(awe)) return { type: 'unsupported', text, meta: { aweType: awe } };
  return { type: 'unsupported', text: null, meta: null };
}
