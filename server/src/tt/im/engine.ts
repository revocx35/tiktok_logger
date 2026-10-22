import { createHash, createPrivateKey, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { maskId } from '../../log.js';
import { deleteMediaFile, downloadToMedia, type Downloader } from '../media.js';
import type { Ingest } from '../ingest.js';
import type { TtMedia, TtMessage, TtReaction, TtThread } from '../types.js';
import {
  buildComboRequest,
  buildHistoryRequest,
  buildInboxRequest,
  buildMarkReadRequest,
  buildReactionRequest,
  buildSendRequest,
  buildUnreactionRequest,
  COMBO_PATH,
  HISTORY_PATH,
  IM_AID,
  INBOX_PATH,
  MARK_READ_PATH,
  parseCombo,
  parseContent,
  parseHistory,
  parseInbox,
  parseSend,
  parseSocketFrame,
  parseStatus,
  SEND_PATH,
  SET_PROPERTY_PATH,
  type ImConversation,
  type ImEvent,
  type ImMessage,
  type SendReply,
} from './proto.js';
import { IM_ORIGIN, randomBogus, type ImTransport } from './transport.js';

/**
 * TikTok's IM protocol, driven from inside the tab — the counterpart of insta_logger's in-tab GraphQL.
 *
 *  - live: the socket's typed frames (`parseSocketFrame`) are stored the moment they arrive;
 *  - catch-up: `get_by_user_combo` is an ascending feed of every message of every conversation after a cursor, so one
 *    small request every few seconds returns whatever the socket missed (and what arrived while the app was down);
 *  - history: `get_by_conversation` pages for the first import and for the unsend check (an unsent message stays in the
 *    history as a placeholder tagged `s:is_recalled`, so unsends are read, not guessed);
 *  - sending: `/v1/message/send` with the DPoP proof TikTok's client sends, signed here with a fresh P-256 key.
 *
 * Nothing opens a conversation in the page, so nothing is marked read by reading, and the page's DOM is not involved.
 */

const SPACING_MS = 350;
const COMBO_PAGES_MAX = 120;
const REWIND_US = 90_000_000n;
const INITIAL_DAYS = 30;

export class ImSendError extends Error {
  constructor(
    message: string,
    /** true when TikTok may have received the message: the caller must not send it again another way */
    readonly maybeSent: boolean,
  ) {
    super(message);
  }
}

interface ConvInfo {
  sourceId: string;
  type: number;
}

export interface EngineHooks {
  /** Something was stored (drives the "last event" clock). */
  activity(): void;
  /** The tab's downloader (profile pictures); null while not connected. */
  downloader?(): Downloader | null;
}

export class ImEngine {
  private readonly convs = new Map<string, ConvInfo>();
  private cursors: [string, string] = ['0', '0'];
  private readonly profiles = new Map<string, { name: string | null; username: string | null; avatar: string | null }>();
  private readonly groupAvatars = new Map<string, string>();
  private peopleAt = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private lastCatchUpAt = 0;
  frames = 0;
  eventsStored = 0;
  lastEventAt: number | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly ingest: Ingest,
    private readonly t: ImTransport,
    private readonly hooks: EngineHooks,
  ) {
    this.loadState();
  }

  /* ------------------------------------------------------------------ state */

  private loadState(): void {
    try {
      const raw = this.ctx.repo.getState('im_state');
      if (!raw) return;
      const j = JSON.parse(raw) as { cursors?: [string, string]; convs?: Record<string, [string, number]> };
      if (j.cursors?.every((c) => /^\d{1,20}$/.test(c))) this.cursors = [j.cursors[0], j.cursors[1]];
      for (const [id, v] of Object.entries(j.convs ?? {})) if (/^\d{1,24}$/.test(v[0])) this.convs.set(id, { sourceId: v[0], type: v[1] });
    } catch {
      /* start from scratch */
    }
  }

  private saveState(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const convs: Record<string, [string, number]> = {};
      for (const [id, c] of this.convs) convs[id] = [c.sourceId, c.type];
      this.ctx.repo.setState('im_state', JSON.stringify({ cursors: this.cursors, convs }));
    }, 1500);
    this.saveTimer.unref();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const convs: Record<string, [string, number]> = {};
    for (const [id, c] of this.convs) convs[id] = [c.sourceId, c.type];
    try {
      this.ctx.repo.setState('im_state', JSON.stringify({ cursors: this.cursors, convs }));
    } catch {
      /* the database is closing */
    }
  }

  /** One IM job at a time: the page's network is shared and TikTok sees a person, not a burst. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  /* ------------------------------------------------------------------ start */

  /** True when the protocol works in this tab (device id present and the conversation list answers). */
  async probe(): Promise<boolean> {
    try {
      const { env } = await this.t.env();
      const r = await this.t.post(INBOX_PATH, buildInboxRequest(env, 10006), {});
      if (r.status !== 200) return false;
      parseInbox(r.body);
      return true;
    } catch (e) {
      this.ctx.log.warn({ err: (e as Error).message }, 'IM protocol probe failed');
      return false;
    }
  }

  private async me(): Promise<string> {
    const { uid } = await this.t.env();
    return this.ingest.me?.id ?? uid;
  }

  /** The conversation list (both kinds), remembering each conversation's short id. */
  async listConversations(): Promise<ImConversation[]> {
    const { env } = await this.t.env();
    const out: ImConversation[] = [];
    for (const kind of [10006, 10002] as const) {
      const r = await this.t.post(INBOX_PATH, buildInboxRequest(env, kind), {});
      if (r.status !== 200) continue;
      for (const c of parseInbox(r.body).conversations) {
        if (!out.some((x) => x.id === c.id)) out.push(c);
        if (c.sourceId) this.convs.set(c.id, { sourceId: c.sourceId, type: c.type });
        if (c.avatarUrl && c.type === 2) this.groupAvatars.set(c.id, c.avatarUrl);
      }
    }
    this.saveState();
    return out;
  }

  /**
   * First import: the conversation list, each conversation's latest messages, then the last [INITIAL_DAYS] days of the
   * all-conversations feed (which also finds conversations the list did not show). Resumes from the stored cursors
   * after a restart: only the catch-up is needed then.
   */
  async initialImport(progress: (done: number, total: number) => void): Promise<void> {
    const me = await this.me();
    const convs = await this.listConversations();
    const known = this.ctx.repo.getState('im_imported') === '1';
    if (this.cursors[0] === '0' && this.cursors[1] === '0') {
      const start = String(BigInt(Date.now() - INITIAL_DAYS * 86400_000) * 1000n);
      this.cursors = [start, start];
    }
    const perChat = this.ctx.settings.get().historyPerChat;
    const todo = known || perChat === 0 ? [] : convs.slice(0, 40);
    progress(0, todo.length);
    let done = 0;
    for (const c of todo) {
      await this.ensureThread(c.id, c, me);
      await this.readHistory(c.id, perChat, 'history', me).catch((e: Error) => this.ctx.log.debug({ err: e.message, chat: maskId(c.id) }, 'history read failed'));
      done++;
      progress(done, todo.length);
      await sleep(SPACING_MS);
    }
    for (const c of convs) await this.ensureThread(c.id, c, me);
    await this.catchUp('history', COMBO_PAGES_MAX);
    this.pruneEmptyChats(new Set(convs.map((c) => c.id)));
    this.ctx.repo.setState('im_imported', '1');
    this.flush();
    void this.refreshPeople().catch((e: Error) => this.ctx.log.debug({ err: e.message }, 'people pass failed'));
  }

  /**
   * The schema-less capture of v1.0–1.5 turned any object with an id in TikTok's answers into a "chat": hundreds of empty
   * rows named by user ids. A chat with no message that TikTok does not list is hidden (soft: it comes back if a message
   * ever arrives for it).
   */
  pruneEmptyChats(listed: Set<string>): number {
    let n = 0;
    const now = Date.now();
    for (const c of this.ctx.repo.listChats()) {
      if (c.message_count > 0 || c.removed_at !== null || listed.has(c.id) || this.convs.has(c.id)) continue;
      this.ctx.repo.markChatRemoved(c.id, now);
      n++;
    }
    if (n) this.ctx.log.info({ hidden: n }, 'hid empty chats that TikTok does not list');
    return n;
  }

  /* ---------------------------------------------------------------- reading */

  /** Reads up to [limit] latest messages of a conversation. Returns how many were stored. */
  async readHistory(chatId: string, limit: number, source: 'history' | 'live', me: string): Promise<number> {
    return this.serial(async () => {
      const info = await this.infoFor(chatId);
      if (!info) return 0;
      const { env } = await this.t.env();
      let cursor = '0';
      let stored = 0;
      let left = limit;
      for (let page = 0; page < 40 && left > 0; page++) {
        const r = await this.t.post(HISTORY_PATH, buildHistoryRequest(env, chatId, info.sourceId, cursor, Math.min(50, left)), {});
        if (r.status !== 200) throw new Error(`history ${r.status}`);
        const h = parseHistory(r.body);
        stored += this.storeMessages(h.messages, source, me);
        this.applyRecalls(h.recalledIds, chatId);
        left -= h.messages.length + h.skipped;
        if (!h.nextCursorUs || h.messages.length + h.skipped === 0 || h.nextCursorUs === cursor) break;
        cursor = h.nextCursorUs;
        await sleep(SPACING_MS);
      }
      return stored;
    });
  }

  /** Everything after the stored cursors, oldest first. Cheap when nothing is new (one small answer). */
  async catchUp(source: 'history' | 'live', maxPages = 6): Promise<number> {
    return this.serial(async () => {
      const me = await this.me();
      const { env } = await this.t.env();
      let total = 0;
      const start: [string, string] = [this.rewind(this.cursors[0]), this.rewind(this.cursors[1])];
      let cur: [string, string] = start;
      for (let page = 0; page < maxPages; page++) {
        const r = await this.t.post(COMBO_PATH, buildComboRequest(env, cur, 50), {});
        if (r.status !== 200) throw new Error(`catch-up ${r.status}`);
        const lanes = parseCombo(r.body);
        let more = false;
        const next: [string, string] = [cur[0], cur[1]];
        for (const lane of lanes) {
          if (lane.kind !== 0 && lane.kind !== 1) continue;
          total += this.storeMessages(lane.messages, source, me);
          this.applyRecalls(lane.recalledIds, null);
          if (lane.next && BigInt(lane.next) > BigInt(next[lane.kind])) next[lane.kind] = lane.next;
          more ||= lane.hasMore && lane.messages.length + lane.recalledIds.length > 0;
          if (BigInt(next[lane.kind]) > BigInt(this.cursors[lane.kind])) this.cursors[lane.kind] = next[lane.kind];
        }
        this.saveState();
        cur = next;
        if (!more) break;
        await sleep(page > 20 ? 600 : 200);
      }
      this.lastCatchUpAt = Date.now();
      return total;
    });
  }

  forgetEnv(): void {
    this.t.forget();
  }

  msSinceCatchUp(): number {
    return Date.now() - this.lastCatchUpAt;
  }

  private rewind(c: string): string {
    const v = BigInt(c || '0');
    return v > REWIND_US ? (v - REWIND_US).toString() : '0';
  }

  /**
   * The unsend check: the newest messages of the most recent conversations are read again; an unsent message is a
   * placeholder row in the history, whose id names the stored message. Returns how many were flagged.
   */
  async reconcile(chats: number): Promise<number> {
    const me = await this.me();
    const rows = this.ctx.repo.listChats().slice(0, chats);
    let flagged = 0;
    for (const c of rows) {
      try {
        const before = this.unsent;
        await this.readHistory(c.id, 50, 'history', me);
        flagged += this.unsent - before;
      } catch (e) {
        this.ctx.log.debug({ err: (e as Error).message, chat: maskId(c.id) }, 'reconcile read failed');
      }
      await sleep(SPACING_MS * 2);
    }
    return flagged;
  }

  /* ----------------------------------------------------------------- storing */

  private storeMessages(msgs: ImMessage[], source: 'history' | 'live', me: string): number {
    let n = 0;
    for (const m of msgs) {
      if (m.sourceId && m.convId && !this.convs.has(m.convId)) {
        this.convs.set(m.convId, { sourceId: m.sourceId, type: m.convId.startsWith('0:1:') ? 1 : 2 });
        this.saveState();
      }
      const tt = toTtMessage(m, me);
      if (!tt) continue;
      this.knownThread(m.convId, me);
      if (this.ingest.message(tt, source)) {
        n++;
        this.eventsStored++;
      }
    }
    if (n) {
      this.lastEventAt = Date.now();
      this.hooks.activity();
      this.wantPeople(msgs);
    }
    return n;
  }

  /** Names for senders we have no contact for (group members above all), without waiting for the periodic pass. */
  private wantPeople(msgs: ImMessage[]): void {
    for (const m of msgs) if (m.senderId && !this.profiles.has(m.senderId) && !this.ctx.repo.getContact(m.senderId)?.name_enc) this.peopleQueue.add(m.senderId);
    if (!this.peopleQueue.size || this.pendingPeople) return;
    this.pendingPeople = true;
    setTimeout(() => {
      this.pendingPeople = false;
      const ids = [...this.peopleQueue].slice(0, 40);
      for (const id of ids) this.peopleQueue.delete(id);
      void this.serial(async () => {
        await this.loadProfiles(ids);
        for (const id of ids) this.applyProfile(id);
      }).catch(() => undefined);
      if (this.peopleQueue.size) this.wantPeople([]);
    }, 1500).unref();
  }

  private readonly peopleQueue = new Set<string>();
  private pendingPeople = false;

  private applyProfile(id: string): void {
    const p = this.profiles.get(id);
    if (p && (p.name || p.username)) this.ingest.upsertContact({ id, username: p.username, name: p.name });
  }

  /**
   * Names and pictures: every peer and every sender we have stored gets its profile (nickname, @name, picture), chats are
   * named from their peer, and pictures are downloaded (a few per pass, retried daily). Runs after the import and then
   * every half hour; cheap when nothing is missing.
   */
  async refreshPeople(): Promise<void> {
    this.peopleAt = Date.now();
    await this.serial(async () => {
      const me = await this.me();
      const ids = new Set<string>();
      const peerOf = new Map<string, string>();
      for (const c of this.ctx.repo.listChats()) {
        if (c.removed_at !== null && c.message_count === 0) continue;
        if (c.kind === 'user' && c.peer_id) {
          ids.add(c.peer_id);
          peerOf.set(c.id, c.peer_id);
        }
      }
      const senders = this.ctx.repo.db.prepare('SELECT DISTINCT sender_id AS id FROM messages WHERE sender_id IS NOT NULL AND from_me = 0 LIMIT 600').all() as { id: string }[];
      for (const s of senders) if (s.id !== me) ids.add(s.id);
      const missing = [...ids].filter((id) => !this.profiles.has(id));
      for (let i = 0; i < missing.length; i += 20) {
        await this.loadProfiles(missing.slice(i, i + 20));
        await sleep(SPACING_MS);
      }
      for (const id of ids) this.applyProfile(id);
      for (const [chatId, peer] of peerOf) {
        const p = this.profiles.get(peer);
        if (p?.name || p?.username) this.ingest.thread({ id: chatId, kind: 'user', peerId: peer, name: p.name ?? p.username });
      }
      this.peopleAt = Date.now();
    });
    const got = await this.syncAvatars(10).catch(() => 0);
    // More pictures waiting: come back in two minutes instead of half an hour.
    if (got >= 10) this.peopleAt = Date.now() - 28 * 60_000;
  }

  peopleAge(): number {
    return Date.now() - this.peopleAt;
  }

  /** Downloads a few missing profile pictures (a failed one is tried again after a day, a good one is renewed weekly). */
  async syncAvatars(max: number): Promise<number> {
    const dl = this.hooks.downloader?.() ?? null;
    if (!dl) return 0;
    const DAY = 86_400_000;
    const now = Date.now();
    let done = 0;
    for (const c of this.ctx.repo.chatsNeedingAvatar(now - 7 * DAY, 80)) {
      if (done >= max) break;
      if (c.removed_at !== null && !c.avatar_checked_at) continue;
      const url = c.kind === 'user' ? this.profiles.get(c.peer_id ?? '')?.avatar : this.groupAvatars.get(c.id);
      if (!url) continue;
      done++;
      const r = await downloadToMedia(this.ctx, dl, url, 'avatar', 'image/jpeg', 4 * 1024 * 1024).catch(() => null);
      if (r?.status === 'ok') {
        const old = c.avatar_media_id;
        this.ctx.repo.setChatAvatar(c.id, r.mediaId, now);
        if (c.kind === 'user' && c.peer_id) this.ctx.repo.setContactAvatar(c.peer_id, r.mediaId, now);
        if (old && old !== r.mediaId) {
          const m = this.ctx.repo.getMedia(old);
          if (m) {
            this.ctx.repo.deleteMedia(m.id);
            await deleteMediaFile(this.ctx, m.path).catch(() => undefined);
          }
        }
        this.ctx.events.emit({ type: 'chat_update', chatId: c.id });
      } else {
        this.ctx.repo.setChatAvatar(c.id, c.avatar_media_id, now - 6 * DAY);
      }
      await sleep(300);
    }
    return done;
  }

  /** The conversation exists in the database (its name arrives asynchronously from the profile lookup). */
  private knownThread(convId: string, me: string): void {
    if (this.ctx.repo.getChat(convId)) return;
    const t = threadFor(convId, null, me);
    this.ingest.thread(t);
    void this.nameThread(convId, me).catch(() => undefined);
  }

  private async ensureThread(convId: string, c: ImConversation | null, me: string): Promise<void> {
    const t = threadFor(convId, c, me);
    const peer = t.peerId ?? null;
    if (peer && !this.profiles.has(peer)) await this.loadProfiles([peer]);
    const p = peer ? this.profiles.get(peer) : null;
    this.ingest.thread({ ...t, name: t.name ?? p?.name ?? p?.username ?? null });
    if (peer && p) this.ingest.upsertContact({ id: peer, username: p.username, name: p.name });
  }

  private async nameThread(convId: string, me: string): Promise<void> {
    await this.ensureThread(convId, null, me);
  }

  /** Display names for user ids (nickname + @name), in batches. Failures are silent: chats keep their id until next time. */
  private async loadProfiles(ids: string[]): Promise<void> {
    const want = ids.filter((id) => /^\d{1,24}$/.test(id) && !this.profiles.has(id));
    for (let i = 0; i < want.length; i += 20) {
      const part = want.slice(i, i + 20);
      try {
        const j = (await this.t.getJson(`https://www.tiktok.com/tiktok/v1/im/user/profile/?aid=${IM_AID}&user_ids=${encodeURIComponent(JSON.stringify(part))}`)) as {
          users?: { im_user_profile?: { user_id_str?: string; unique_id?: string; nick_name?: string; avatars?: { avatar_medium?: { url_list?: string[] }; avatar_thumb?: { url_list?: string[] } } } }[];
        };
        for (const u of j.users ?? []) {
          const p = u.im_user_profile;
          if (p?.user_id_str) this.profiles.set(p.user_id_str, { name: p.nick_name || null, username: p.unique_id || null, avatar: p.avatars?.avatar_medium?.url_list?.[0] ?? p.avatars?.avatar_thumb?.url_list?.[0] ?? null });
        }
      } catch {
        /* try again on a later message */
      }
    }
  }

  private applyRecalls(serverIds: string[], chatId: string | null): void {
    for (const id of serverIds) {
      const row = this.ctx.repo.findMessage(id);
      if (!row || (chatId && row.chat_id !== chatId)) continue;
      if (this.ingest.unsend(row.id, 'sender')) {
        this.unsent++;
        this.lastEventAt = Date.now();
      }
    }
  }

  unsent = 0;

  /* -------------------------------------------------------------- live frames */

  /** One binary frame of the socket. Returns true when it was a TikTok IM event we understood. */
  handleFrame(bytes: Buffer): boolean {
    let ev: ImEvent | null;
    try {
      ev = parseSocketFrame(bytes);
    } catch {
      return false;
    }
    if (!ev) return false;
    this.frames++;
    const me = this.ingest.me?.id ?? '';
    switch (ev.kind) {
      case 'message':
        if (this.storeMessages([ev.message], 'live', me)) this.lastEventAt = Date.now();
        break;
      case 'recall':
        this.applyRecalls([ev.serverId], ev.convId);
        break;
      case 'reaction': {
        const row = this.ctx.repo.findMessage(ev.serverId);
        if (row) {
          const r: TtReaction = { senderId: ev.userId, emoji: ev.emoji, removed: ev.removed, ts: Date.now() };
          this.ingest.reaction(row.id, r);
        }
        break;
      }
      default:
        break;
    }
    return true;
  }

  /* ------------------------------------------------------------------ sending */

  private async infoFor(chatId: string): Promise<ConvInfo | null> {
    const hit = this.convs.get(chatId);
    if (hit) return hit;
    await this.listConversations().catch(() => undefined);
    const again = this.convs.get(chatId);
    if (again) return again;
    // Not in the list (older conversation): the all-conversations feed names every conversation that has messages.
    const { env } = await this.t.env();
    const start = String(BigInt(Date.now() - 365 * 86400_000) * 1000n);
    let cur: [string, string] = [start, start];
    for (let page = 0; page < 30; page++) {
      const r = await this.t.post(COMBO_PATH, buildComboRequest(env, cur, 50), {});
      if (r.status !== 200) break;
      const lanes = parseCombo(r.body);
      for (const lane of lanes) for (const m of lane.messages) if (m.sourceId && !this.convs.has(m.convId)) this.convs.set(m.convId, { sourceId: m.sourceId, type: m.convId.startsWith('0:1:') ? 1 : 2 });
      if (this.convs.has(chatId)) {
        this.saveState();
        return this.convs.get(chatId)!;
      }
      const next: [string, string] = [cur[0], cur[1]];
      for (const lane of lanes) if ((lane.kind === 0 || lane.kind === 1) && lane.next) next[lane.kind] = lane.next;
      if (!lanes.some((l) => l.hasMore)) break;
      cur = next;
      await sleep(250);
    }
    return null;
  }

  /** Sends a text message. Returns TikTok's id of it (already stored). */
  async sendText(chatId: string, text: string, reply?: SendReply | null): Promise<string> {
    return this.serial(async () => {
      const info = await this.infoFor(chatId);
      if (!info) throw new ImSendError('This conversation is not known to TikTok yet. Open it on the TikTok screen once.', false);
      const { env } = await this.t.env();
      const me = await this.me();
      const keys = ticketGuard();
      const clientId = randomUUID();
      const url = `${IM_ORIGIN}${SEND_PATH}`;
      const body = buildSendRequest(env, { convId: chatId, sourceId: info.sourceId, isGroup: info.type === 2, text, clientMessageId: clientId, publicKeyB64: keys.publicKeyB64, reply: reply ?? null });
      const sent = await this.postSend(url, body, env, keys);
      const id = sent.messageId && /^\d{5,24}$/.test(sent.messageId) ? sent.messageId : `srv:${createHash('sha256').update(clientId).digest('base64url').slice(0, 22)}`;
      const msg: TtMessage = {
        id,
        threadId: chatId,
        senderId: me,
        fromMe: true,
        ts: Date.now(),
        type: reply ? 'text' : 'text',
        text,
        ...(reply ? { quotedId: reply.messageId } : {}),
        source: 'sent',
      };
      this.knownThread(chatId, me);
      return this.ingest.message(msg, 'sent') ?? id;
    });
  }

  /**
   * Shares a TikTok post into a conversation as a **card** (what TikTok's own share does), not as a link in a text
   * message: the content is an `aweType: 800` body carrying the item id and its author, which the app renders as a
   * shared post and the other side sees like any shared video.
   */
  async sendShare(chatId: string, share: { itemId: string; uid: string; secUid?: string; title?: string; cover?: { uri?: string; urls: string[] } | null }): Promise<string> {
    return this.serial(async () => {
      const info = await this.infoFor(chatId);
      if (!info) throw new ImSendError('This conversation is not known to TikTok yet. Open it on the TikTok screen once.', false);
      const { env } = await this.t.env();
      const me = await this.me();
      const keys = ticketGuard();
      const clientId = randomUUID();
      const url = `${IM_ORIGIN}${SEND_PATH}`;
      const body = buildSendRequest(env, {
        convId: chatId,
        sourceId: info.sourceId,
        isGroup: info.type === 2,
        text: '',
        clientMessageId: clientId,
        publicKeyB64: keys.publicKeyB64,
        share,
      });
      const sent = await this.postSend(url, body, env, keys);
      const id = sent.messageId && /^\d{5,24}$/.test(sent.messageId) ? sent.messageId : `srv:${createHash('sha256').update(clientId).digest('base64url').slice(0, 22)}`;
      const msg: TtMessage = {
        id,
        threadId: chatId,
        senderId: me,
        fromMe: true,
        ts: Date.now(),
        type: 'shared_post',
        text: share.title ?? null,
        meta: { itemId: share.itemId, uid: share.uid, ...(share.cover ? { cover: share.cover } : {}) },
        source: 'sent',
      };
      this.knownThread(chatId, me);
      return this.ingest.message(msg, 'sent') ?? id;
    });
  }

  /**
   * Adds (or takes back) a reaction on a message: `/v1/message/set_property`, envelope 705 / 10008.
   *
   * The reaction is applied locally at once so the UI answers immediately; the socket or the next catch-up confirms it
   * (and brings the other side's reactions).
   */
  async react(chatId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    await this.serial(async () => {
      const info = await this.infoFor(chatId);
      if (!info) throw new ImSendError('This conversation is not known to TikTok yet. Open it on the TikTok screen once.', false);
      if (!/^\d{5,24}$/.test(messageId)) throw new ImSendError('Only messages TikTok itself numbered can be reacted to.', false);
      const { env } = await this.t.env();
      const me = await this.me();
      const keys = ticketGuard();
      const url = `${IM_ORIGIN}${SET_PROPERTY_PATH}`;
      const args = {
        convId: chatId,
        sourceId: info.sourceId,
        messageId,
        emoji,
        selfUserId: me,
        isGroup: info.type === 2,
        clientMessageId: randomUUID(),
        publicKeyB64: keys.publicKeyB64,
      };
      const body = remove ? buildUnreactionRequest(env, args) : buildReactionRequest(env, args);
      let reply;
      try {
        reply = await this.t.post(SET_PROPERTY_PATH, body, {
          query: {
            aid: IM_AID,
            version_code: '1.0.0',
            app_name: 'tiktok_web',
            device_platform: 'web_pc',
            'ztca-version': '1',
            'ztca-dpop': keys.dpop('POST', url),
            msToken: env.msToken,
            'X-Bogus': randomBogus(),
          },
          headers: {
            'tt-ticket-guard-iteration-version': '0',
            'tt-ticket-guard-public-key': keys.publicKeyB64,
            'tt-ticket-guard-version': '2',
            'tt-ticket-guard-web-version': '1',
          },
        });
      } catch (e) {
        throw new ImSendError(`TikTok did not answer (${(e as Error).message})`, true);
      }
      if (reply.status !== 200) throw new ImSendError(`TikTok refused the reaction (HTTP ${reply.status}).`, false);
      const status = parseStatus(reply.body);
      if (status !== '0' && status !== '') throw new ImSendError(`TikTok refused the reaction (status ${status}).`, false);
      this.ingest.reaction(messageId, { senderId: me, emoji, removed: remove, ts: Date.now() });
      this.ctx.events.emit({ type: 'message_update', chatId, messageId, reason: 'reaction' });
    });
  }

  /** The shared POST for /v1/message/send (text and shares): DPoP + ticket-guard, refusal mapped to an error. */
  private async postSend(
    url: string,
    body: Buffer,
    env: { msToken: string },
    keys: { publicKeyB64: string; dpop: (m: string, u: string) => string },
  ): Promise<{ status: string; messageId: string }> {
    let reply;
    try {
      reply = await this.t.post(SEND_PATH, body, {
        query: {
          aid: IM_AID,
          version_code: '1.0.0',
          app_name: 'tiktok_web',
          device_platform: 'web_pc',
          'ztca-version': '1',
          'ztca-dpop': keys.dpop('POST', url),
          msToken: env.msToken,
          'X-Bogus': randomBogus(),
        },
        headers: {
          'tt-ticket-guard-iteration-version': '0',
          'tt-ticket-guard-public-key': keys.publicKeyB64,
          'tt-ticket-guard-version': '2',
          'tt-ticket-guard-web-version': '1',
        },
      });
    } catch (e) {
      // The request may or may not have reached TikTok: do not retry through another path.
      throw new ImSendError(`TikTok did not answer (${(e as Error).message})`, true);
    }
    if (reply.status !== 200) throw new ImSendError(`TikTok refused the message (HTTP ${reply.status}).`, false);
    const sent = parseSend(reply.body);
    if (sent.status !== '0' && sent.status !== '') throw new ImSendError(`TikTok refused the message (status ${sent.status}).`, false);
    return sent;
  }

  /** Marks a conversation read up to its newest message (what opening it in the page would do). */
  async markRead(chatId: string): Promise<void> {
    await this.serial(async () => {
      const info = await this.infoFor(chatId);
      if (!info) return;
      const { env } = await this.t.env();
      const h = await this.t.post(HISTORY_PATH, buildHistoryRequest(env, chatId, info.sourceId, '0', 1), {});
      if (h.status !== 200) return;
      const newest = parseHistory(h.body).messages.at(-1)?.tsUs;
      if (!newest) return;
      const r = await this.t.post(MARK_READ_PATH, buildMarkReadRequest(env, { convId: chatId, sourceId: info.sourceId, convType: info.type, readIndex: newest }), {});
      if (r.status !== 200 || (parseStatus(r.body) !== '0' && parseStatus(r.body) !== '')) throw new AppError(502, 'read', 'TikTok did not mark the conversation read.');
    });
  }

  /** Fresh links for a message's media: re-read its conversation's latest page (links in memory are replaced). */
  async refreshConversation(chatId: string): Promise<void> {
    const me = await this.me();
    await this.readHistory(chatId, 100, 'live', me);
  }
}

/* ---------------------------------------------------------------- mapping */

function threadFor(convId: string, c: ImConversation | null, me: string): TtThread {
  const dm = convId.startsWith('0:1:') || c?.type === 1;
  if (dm) {
    const ids = convId.split(':').slice(2).filter((x) => /^\d{1,24}$/.test(x));
    const peer = (c?.members ?? ids).find((x) => x !== me) ?? ids.find((x) => x !== me) ?? null;
    return { id: convId, kind: 'user', peerId: peer, name: null };
  }
  return { id: convId, kind: 'group', name: c?.title ?? null, lastTs: c ? Math.round(Number(c.lastTsUs) / 1000) || null : null };
}

export function toTtMessage(m: ImMessage, me: string): TtMessage | null {
  if (!m.serverId || !m.convId) return null;
  const ts = Math.round(Number(m.tsUs) / 1000);
  if (!Number.isFinite(ts) || ts < 1e11) return null;
  const c = parseContent(m);
  const media: TtMedia[] = m.media
    ? [
        {
          url: m.media.url,
          kind: m.media.kind,
          width: m.media.width,
          height: m.media.height,
          durationMs: m.media.durationMs,
          thumbUrl: m.media.thumbUrl,
          ...(m.media.decryptKey ? { decryptKey: m.media.decryptKey } : {}),
        },
      ]
    : [];
  const reactions: TtReaction[] = m.reactions.flatMap((r) => r.userIds.map((u) => ({ senderId: u, emoji: r.key })));
  return {
    id: m.serverId,
    threadId: m.convId,
    senderId: m.senderId || null,
    fromMe: !!me && m.senderId === me,
    ts,
    type: c.type,
    text: c.text,
    ...(media.length ? { media } : {}),
    quotedId: m.replyToServerId,
    ...(reactions.length ? { reactions } : {}),
    meta: c.meta,
    source: 'history',
  };
}

/* --------------------------------------------------------------- DPoP proof */

/** A fresh P-256 key and the DPoP proof (RFC 9449 shape, ES256) TikTok's send endpoint wants next to the public key. */
export function ticketGuard(): { publicKeyB64: string; dpop: (method: string, url: string) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  return {
    publicKeyB64: point.toString('base64'),
    dpop: (method, url) => {
      const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y } };
      const payload = { jti: randomBytes(32).toString('base64url'), htm: method, htu: url, iat: Math.floor(Date.now() / 1000) };
      const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      const sig = createSign('SHA256').update(input).sign({ key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
      return `${input}.${sig.toString('base64url')}`;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
