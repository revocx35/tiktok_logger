import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { EventBus } from '../events.js';
import { F } from '../db/repo.js';
import type { MessageRow } from '../db/repo.js';
import { maskId } from '../log.js';
import { isSyntheticId, syntheticId, type TtMedia, type TtMessage, type TtReaction, type TtThread, type TtUser } from './types.js';

/**
 * Writing captured records into the encrypted database.
 *
 * Identity: a message's primary key is TikTok's server id when we have it, else `srv:<hash of its content>`. When
 * the server's id turns up later (the same message seen through the network instead of the DOM) the row is kept and
 * `alt_id` gets the real id, so unsend/reactions/quotes that arrive under the real id still find the row. A
 * `dedupe_key` (content, to the minute) makes the two capture paths meet without duplicating anything.
 *
 * A message with several photos/videos is stored as the message plus `<id>~1`, `<id>~2`, … rows (album parts, as
 * wa_logger/insta_logger do): each part has its own media file, the view groups them.
 */

export interface MediaSource {
  url: string;
  kind: TtMedia['kind'];
  mime?: string | null;
  fallbackUrl?: string | null;
}

/** Signed CDN links of the messages we are about to store. Memory only — they are credentials to private files. */
export class MediaSources {
  private readonly map = new Map<string, MediaSource>();

  set(messageId: string, source: MediaSource): void {
    this.map.set(messageId, source);
  }
  get(messageId: string): MediaSource | undefined {
    return this.map.get(messageId);
  }
  delete(messageId: string): void {
    this.map.delete(messageId);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

export interface MediaSink {
  enqueue(messageId: string, priority: 'live' | 'history'): void;
}

export type Source = 'live' | 'history' | 'dom' | 'sent';

export interface Me {
  id: string;
  username: string | null;
  name: string | null;
}

/** Content identity used to merge the DOM's view with the network's view of one message. */
export function contentKey(m: { threadId: string; senderId: string | null; fromMe: boolean; ts: number; text?: string | null; media?: TtMedia[]; type: string }): string {
  const body = (m.text ?? '').trim();
  const media = (m.media ?? []).map((x) => x.url.split('?')[0]).join(',');
  return createHash('sha256')
    .update(`${m.threadId}|${m.fromMe ? 'me' : (m.senderId ?? '')}|${Math.floor(m.ts / 60_000)}|${m.type}|${body}|${media}`)
    .digest('hex');
}

const MEDIA_MIME: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', sticker: 'image/webp', file: 'application/octet-stream' };

export class Ingest {
  me: Me | null = null;
  private readonly knownChats = new Set<string>();
  private readonly knownContacts = new Map<string, string | null>();

  constructor(
    private readonly ctx: AppContext,
    private readonly events: EventBus,
    private readonly sources: MediaSources,
    private readonly media: MediaSink,
  ) {}

  resetCaches(): void {
    this.knownChats.clear();
    this.knownContacts.clear();
  }

  isMe(id: string | null | undefined): boolean {
    return !!id && this.me !== null && id === this.me.id;
  }

  /* ------------------------------------------------------------- contacts */

  upsertContact(u: TtUser, force = false): void {
    if (!u.id || !/^\d{1,24}$/.test(u.id)) return;
    const w = this.ctx.writer();
    if (!w) return;
    const fingerprint = `${u.username ?? ''}|${u.name ?? ''}`;
    const cached = this.knownContacts.get(u.id);
    if (!force && cached !== undefined && cached === fingerprint) return;
    this.ctx.repo.upsertContact({
      id: u.id,
      user_id: u.id,
      username_enc: u.username ? w.encrypt('contacts', 'username', u.id, u.username) : null,
      name_enc: u.name ? w.encrypt('contacts', 'name', u.id, u.name) : null,
      is_me: this.isMe(u.id),
      is_verified: u.verified === true,
      now: Date.now(),
    });
    this.knownContacts.set(u.id, fingerprint);
  }

  /* ---------------------------------------------------------------- chats */

  /** Stores/refreshes a conversation, and its peer contact. Returns the chat id. */
  thread(t: TtThread, now = Date.now()): string {
    const w = this.ctx.writer();
    if (w) {
      this.ctx.repo.upsertChat({
        id: t.id,
        kind: t.kind,
        thread_id: t.id,
        peer_id: t.peerId ?? null,
        name_enc: t.name ? w.encrypt(...F.chatName(t.id), t.name) : null,
        last_ts: t.lastTs ?? null,
        folder: t.folder ?? undefined,
        pinned: t.pinned,
        muted: t.muted,
        now,
      });
    }
    if (t.peerId) this.upsertContact({ id: t.peerId, name: t.name ?? null, avatarUrl: t.avatarUrl ?? null });
    for (const m of t.members ?? []) this.upsertContact(m);
    this.knownChats.add(t.id);
    return t.id;
  }

  /** Makes sure a chat row exists for an id we only saw in a message (no conversation record yet). */
  ensureChat(chatId: string, now = Date.now()): void {
    if (this.knownChats.has(chatId)) return;
    if (this.ctx.repo.getChat(chatId)) {
      this.knownChats.add(chatId);
      return;
    }
    this.thread({ id: chatId, kind: 'user' }, now);
  }

  /* ------------------------------------------------------------- messages */

  /** Stores one message (and its album parts). Returns our id of the message, or null when it was ignored. */
  message(m: TtMessage, source: Source): string | null {
    const w = this.ctx.writer();
    if (!w || !m.threadId || !m.ts) return null;
    const now = Date.now();
    this.ensureChat(m.threadId, now);
    // In a one-to-one conversation the other side's id is the chat's peer: a row read off the page (which does not
    // name the sender) and the same message arriving through the network must hash to the same content key.
    let senderId = m.senderId;
    if (!m.fromMe && !senderId) {
      const chat = this.ctx.repo.getChat(m.threadId);
      if (chat?.kind === 'user' && chat.peer_id) senderId = chat.peer_id;
    }
    // A first message names the peer before the conversation record does: remember it, so later reads hash the same.
    if (!m.fromMe && senderId) {
      const chat = this.ctx.repo.getChat(m.threadId);
      if (chat && !chat.peer_id) this.ctx.repo.upsertChat({ id: chat.id, kind: chat.kind, peer_id: senderId, now });
    }
    m = { ...m, senderId };
    const key = contentKey(m);
    const realId = m.id && !isSyntheticId(m.id) ? m.id : null;
    const id = realId ?? syntheticId(key);
    const media = (m.media ?? []).slice(0, 10);

    let existing = this.ctx.repo.findMessage(id);
    if (!existing) existing = this.ctx.repo.messageByDedupe(m.threadId, key);
    if (!existing) existing = this.ctx.repo.findSyntheticTwin(m.threadId, m.ts, m.fromMe);

    if (existing) {
      const patch: Partial<MessageRow> = { updated_at: now };
      if (source !== 'dom' && existing.source === 'dom') {
        // The network's record is more precise than the page's reading: take its time, type and server id.
        patch.ts = m.ts;
        patch.type = m.type;
        patch.source = source;
        patch.dedupe_key = key;
        if (realId && existing.id !== realId && !existing.alt_id) patch.alt_id = realId;
      }
      if (m.text && !existing.body_enc) patch.body_enc = w.encrypt(...F.body(existing.id), m.text);
      if (m.edited) patch.edited_at = now;
      if (Object.keys(patch).length > 1) this.ctx.repo.updateMessage(existing.id, patch);
      if (media.length && existing.media_status === 'none') {
        this.ctx.repo.updateMessage(existing.id, { media_status: 'pending', media_w: media[0]?.width ?? null, media_h: media[0]?.height ?? null });
        this.queueMedia(existing.id, media[0]!, m.threadId, source);
      }
      for (const r of m.reactions ?? []) this.reaction(existing.id, r);
      return existing.id;
    }

    this.insertRow({
      id,
      chatId: m.threadId,
      senderId: m.fromMe ? (this.me?.id ?? m.senderId) : m.senderId,
      fromMe: m.fromMe,
      ts: m.ts,
      type: m.type,
      text: m.text ?? null,
      meta: m.meta ?? null,
      quotedId: m.quotedId ?? null,
      media: media[0] ?? null,
      albumIndex: media.length > 1 ? 0 : null,
      albumCount: media.length > 1 ? media.length : null,
      viewOnce: m.viewOnce === true,
      forwarded: m.forwarded === true,
      expiresAt: m.expiresAt ?? null,
      edited: m.edited === true,
      source,
      dedupeKey: key,
      now,
    });
    for (let i = 1; i < media.length; i++) {
      this.insertRow({
        id: `${id}~${i}`,
        chatId: m.threadId,
        senderId: m.fromMe ? (this.me?.id ?? m.senderId) : m.senderId,
        fromMe: m.fromMe,
        ts: m.ts,
        type: m.type,
        text: null,
        meta: m.meta ?? null,
        quotedId: null,
        media: media[i]!,
        albumIndex: i,
        albumCount: media.length,
        viewOnce: m.viewOnce === true,
        forwarded: m.forwarded === true,
        expiresAt: m.expiresAt ?? null,
        edited: false,
        source,
        dedupeKey: `${key}~${i}`,
        now,
      });
    }
    this.ctx.repo.bumpChatTs(m.threadId, m.ts, now);
    for (const r of m.reactions ?? []) this.reaction(id, r);
    this.events.emit({ type: 'message', chatId: m.threadId, messageId: id });
    return id;
  }

  private insertRow(a: {
    id: string;
    chatId: string;
    senderId: string | null;
    fromMe: boolean;
    ts: number;
    type: string;
    text: string | null;
    meta: Record<string, unknown> | null;
    quotedId: string | null;
    media: TtMedia | null;
    albumIndex: number | null;
    albumCount: number | null;
    viewOnce: boolean;
    forwarded: boolean;
    expiresAt: number | null;
    edited: boolean;
    source: Source;
    dedupeKey: string;
    now: number;
  }): void {
    const w = this.ctx.writer();
    if (!w) return;
    this.ctx.repo.insertMessage({
      id: a.id,
      alt_id: null,
      dedupe_key: a.dedupeKey,
      chat_id: a.chatId,
      sender_id: a.fromMe ? (this.me?.id ?? a.senderId) : a.senderId,
      from_me: a.fromMe ? 1 : 0,
      ts: a.ts,
      type: a.type,
      body_enc: a.text ? w.encrypt(...F.body(a.id), a.text) : null,
      meta_enc: a.meta ? w.encryptJson(...F.meta(a.id), a.meta) : null,
      quoted_id: a.quotedId,
      media_id: null,
      media_status: a.media ? 'pending' : 'none',
      media_attempts: 0,
      media_size: null,
      media_w: a.media?.width ?? null,
      media_h: a.media?.height ?? null,
      media_duration: a.media?.durationMs ?? null,
      album_index: a.albumIndex,
      album_count: a.albumCount,
      is_view_once: a.viewOnce ? 1 : 0,
      is_forwarded: a.forwarded ? 1 : 0,
      expires_at: a.expiresAt,
      ack: null,
      deleted_at: null,
      deleted_by: null,
      edited_at: a.edited ? a.now : null,
      last_edit_key: null,
      source: a.source,
      captured_at: a.now,
      updated_at: a.now,
    });
    if (a.media) this.queueMedia(a.id, a.media, a.chatId, a.source);
  }

  private queueMedia(messageId: string, media: TtMedia, chatId: string, source: Source): void {
    this.sources.set(messageId, { url: media.url, kind: media.kind, mime: media.mime ?? MEDIA_MIME[media.kind] ?? null });
    this.media.enqueue(messageId, source === 'history' ? 'history' : 'live');
    this.events.emit({ type: 'chat_update', chatId });
  }

  /** Marks a message the server no longer shows as removed ("sender" when TikTok said so, else "missing"). */
  unsend(messageId: string, by: 'sender' | 'missing', at = Date.now()): boolean {
    const row = this.ctx.repo.findMessage(messageId);
    if (!row || row.deleted_at !== null) return false;
    this.ctx.repo.updateMessage(row.id, { deleted_at: at, deleted_by: by, updated_at: at });
    this.events.emit({ type: 'message_update', chatId: row.chat_id, messageId: row.id, reason: 'deleted' });
    return true;
  }

  reaction(messageId: string, r: TtReaction): void {
    const row = this.ctx.repo.findMessage(messageId);
    if (!row) return;
    const w = this.ctx.writer();
    if (!w) return;
    this.ctx.repo.upsertReaction({
      message_id: row.id,
      sender_id: r.senderId,
      emoji_enc: w.encrypt('reactions', 'emoji', `${row.id}|${r.senderId}`, r.emoji),
      ts: r.ts ?? Date.now(),
      removed: r.removed === true,
    });
    this.events.emit({ type: 'message_update', chatId: row.chat_id, messageId: row.id, reason: 'reaction' });
  }

  /**
   * Anti-delete: of the stored messages of [chatId] inside the re-read window, the ones TikTok no longer shows are
   * flagged `missing`. Only messages older than 60 s are judged (a message still uploading is not "gone") and only
   * ones strictly inside the re-read range (the oldest row could simply be the boundary of what was rendered).
   */
  markMissing(chatId: string, seen: Set<string>, fromTs: number, toTs: number, now = Date.now()): number {
    let n = 0;
    for (const m of this.ctx.repo.messageIdsBetween(chatId, fromTs, Math.min(toTs, now - 60_000))) {
      if (seen.has(m.id)) continue;
      // The read starts at some message; anything older is simply not on screen, so only the range from the read's
      // first message on is judged (a deletion at the very top of a conversation waits for a read that starts
      // further back, which the import's scroll-up does).
      if (m.ts <= fromTs) continue;
      const row = this.ctx.repo.findMessage(m.id);
      if (!row || row.deleted_at !== null) continue;
      this.ctx.repo.updateMessage(row.id, { deleted_at: now, deleted_by: 'missing', updated_at: now });
      this.events.emit({ type: 'message_update', chatId, messageId: row.id, reason: 'deleted' });
      n++;
    }
    return n;
  }

  /** One line for the log: ids only, never content. */
  describe(m: TtMessage): string {
    return `${maskId(m.threadId)} ${m.type}${m.fromMe ? ' (mine)' : ''}`;
  }
}
