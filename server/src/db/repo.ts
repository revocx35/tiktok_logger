import type { DataKeyStore, WrappedDek } from '../crypto/keyring.js';
import type { DB } from './db.js';

/* ---------------------------------------------------------------- rows */

export interface OwnerRow {
  id: 1;
  username: string;
  pw_salt: Buffer;
  pw_auth_hash: Buffer;
  public_key: Buffer;
  privkey_pw: Buffer;
  privkey_recovery: Buffer;
  recovery_salt: Buffer;
  recovery_auth_hash: Buffer;
  totp_secret_enc: Buffer | null;
  totp_enabled: number;
  totp_last_step: number | null;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  password_changed_at: number;
}

export interface PendingClaimRow {
  id: 1;
  username: string;
  mode: 'new' | 'reset';
  salt: Buffer;
  auth_hash: Buffer;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
}

/** The brute-force counters of whatever credential currently guards the account. */
export interface AuthLock {
  failed_logins: number;
  locked_until: number | null;
}

export interface SessionRow {
  id_hash: Buffer;
  privkey_enc: Buffer;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  event: string;
  ip: string | null;
  detail: string | null;
}

export interface MediaRow {
  id: number;
  path: string;
  key_id: number;
  mime_enc: Buffer | null;
  filename_enc: Buffer | null;
  size: number;
  kind: 'message' | 'avatar' | 'story';
  created_at: number;
}

export interface ChatRow {
  id: string;
  kind: string;
  thread_id: string | null;
  peer_id: string | null;
  name_enc: Buffer | null;
  last_ts: number | null;
  folder: string | null;
  pinned: number;
  muted: number;
  removed_at: number | null;
  avatar_media_id: number | null;
  avatar_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ContactRow {
  id: string;
  user_id: string | null;
  username_enc: Buffer | null;
  name_enc: Buffer | null;
  is_me: number;
  is_verified: number;
  avatar_media_id: number | null;
  avatar_checked_at: number | null;
  updated_at: number;
}

export interface MessageRow {
  rowid: number;
  id: string;
  alt_id: string | null;
  dedupe_key: string | null;
  chat_id: string;
  sender_id: string | null;
  from_me: number;
  ts: number;
  type: string;
  body_enc: Buffer | null;
  meta_enc: Buffer | null;
  quoted_id: string | null;
  media_id: number | null;
  media_status: string;
  media_attempts: number;
  media_size: number | null;
  media_w: number | null;
  media_h: number | null;
  media_duration: number | null;
  /** Part of a multi-photo/video message: position and count (null otherwise). */
  album_index: number | null;
  album_count: number | null;
  is_view_once: number;
  is_forwarded: number;
  /** Disappearing message: when TikTok removes it; null when it doesn't. */
  expires_at: number | null;
  ack: number | null;
  deleted_at: number | null;
  deleted_by: string | null;
  edited_at: number | null;
  last_edit_key: string | null;
  source: string;
  captured_at: number;
  updated_at: number;
}

export type NewMessage = Omit<MessageRow, 'rowid'>;

export interface EditRow {
  id: number;
  message_id: string;
  body_enc: Buffer | null;
  captured_at: number;
}

export interface ReactionRow {
  message_id: string;
  sender_id: string;
  emoji_enc: Buffer | null;
  ts: number;
  removed_at: number | null;
}

export interface ChatListRow extends ChatRow {
  message_count: number;
  deleted_count: number;
  lm_id: string | null;
}

/* ------------------------------------------------------------- cursors */

export interface Cursor {
  ts: number;
  rowid: number;
}

export function encodeCursor(c: Cursor): string {
  return `${c.ts}_${c.rowid}`;
}

export function decodeCursor(s: string | undefined | null): Cursor | null {
  if (!s) return null;
  const m = /^(\d{1,16})_(\d{1,16})$/.exec(s);
  if (!m) return null;
  return { ts: Number(m[1]), rowid: Number(m[2]) };
}

/* ----------------------------------------------------------------- AAD */

/** Field-encryption contexts. Message bodies and their edit history share the "msgbody" context. */
export const F = {
  chatName: (id: string) => ['chats', 'name', id] as const,
  contactName: (id: string) => ['contacts', 'name', id] as const,
  contactUsername: (id: string) => ['contacts', 'username', id] as const,
  body: (messageId: string) => ['msgbody', 'body', messageId] as const,
  meta: (messageId: string) => ['messages', 'meta', messageId] as const,
  reaction: (messageId: string, senderId: string) => ['reactions', 'emoji', `${messageId}|${senderId}`] as const,
  mediaMime: (path: string) => ['media', 'mime', path] as const,
  mediaFilename: (path: string) => ['media', 'filename', path] as const,
  storyUsername: (id: string) => ['story_users', 'username', id] as const,
  storyName: (id: string) => ['story_users', 'name', id] as const,
  storyMime: (id: string) => ['stories', 'mime', id] as const,
};

export interface StoryUserRow {
  id: string;
  username_enc: Buffer | null;
  name_enc: Buffer | null;
  avatar_url: string | null;
  avatar_media_id: number | null;
  avatar_checked_at: number | null;
  last_story_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoryUserListRow extends StoryUserRow {
  count: number;
  latest: number | null;
}

export interface StoryRow {
  id: string;
  user_id: string;
  type: 'image' | 'video';
  taken_at: number;
  expires_at: number | null;
  media_id: number | null;
  mime_enc: Buffer | null;
  likes: number | null;
  plays: number | null;
  status: 'pending' | 'downloaded' | 'failed' | 'too_large';
  attempts: number;
  captured_at: number;
}

/* ---------------------------------------------------------------- repo */

const OWNER_UPDATABLE = new Set<keyof OwnerRow>([
  'pw_salt',
  'pw_auth_hash',
  'privkey_pw',
  'privkey_recovery',
  'recovery_salt',
  'recovery_auth_hash',
  'totp_secret_enc',
  'totp_enabled',
  'totp_last_step',
  'failed_logins',
  'locked_until',
  'password_changed_at',
]);

const MESSAGE_UPDATABLE = new Set<keyof MessageRow>([
  'alt_id',
  'dedupe_key',
  'source',
  'sender_id',
  'from_me',
  'ts',
  'type',
  'body_enc',
  'meta_enc',
  'quoted_id',
  'media_id',
  'media_status',
  'media_attempts',
  'media_size',
  'media_w',
  'media_h',
  'media_duration',
  'album_index',
  'album_count',
  'is_view_once',
  'is_forwarded',
  'expires_at',
  'ack',
  'deleted_at',
  'deleted_by',
  'edited_at',
  'last_edit_key',
  'updated_at',
]);

function buildUpdate<T extends object>(allowed: Set<keyof T>, patch: Partial<T>): { sets: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) as (keyof T)[];
  for (const k of keys) if (!allowed.has(k)) throw new Error(`column not updatable: ${String(k)}`);
  return {
    sets: keys.map((k) => `${String(k)} = ?`).join(', '),
    values: keys.map((k) => (patch as Record<string, unknown>)[k as string]),
  };
}

const MSG_COLS = 'rowid, *';

export class Repo implements DataKeyStore {
  constructor(public readonly db: DB) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* ------------------------------------------------------------ state */

  getState(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
  }

  /* ------------------------------------------------------------ owner */

  getOwner(): OwnerRow | undefined {
    return this.db.prepare('SELECT * FROM owner WHERE id = 1').get() as OwnerRow | undefined;
  }

  hasOwner(): boolean {
    return !!this.db.prepare('SELECT 1 FROM owner WHERE id = 1').get();
  }

  /** Returns false if an owner already exists (signup race). */
  createOwner(row: Omit<OwnerRow, 'id' | 'totp_secret_enc' | 'totp_enabled' | 'totp_last_step' | 'failed_logins' | 'locked_until'>): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO owner (id, username, pw_salt, pw_auth_hash, public_key, privkey_pw, privkey_recovery,
           recovery_salt, recovery_auth_hash, created_at, password_changed_at)
         VALUES (1, @username, @pw_salt, @pw_auth_hash, @public_key, @privkey_pw, @privkey_recovery,
           @recovery_salt, @recovery_auth_hash, @created_at, @password_changed_at)`,
      )
      .run(row);
    return res.changes === 1;
  }

  updateOwner(patch: Partial<OwnerRow>): void {
    const { sets, values } = buildUpdate(OWNER_UPDATABLE, patch);
    if (!sets) return;
    this.db.prepare(`UPDATE owner SET ${sets} WHERE id = 1`).run(...values);
  }

  /* ---------------------------------------------------- pending claim */

  getPendingClaim(): PendingClaimRow | undefined {
    return this.db.prepare('SELECT * FROM pending_claim WHERE id = 1').get() as PendingClaimRow | undefined;
  }

  setPendingClaim(row: { username: string; mode: 'new' | 'reset'; salt: Buffer; auth_hash: Buffer }, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO pending_claim (id, username, mode, salt, auth_hash, failed_logins, locked_until, created_at)
         VALUES (1, @username, @mode, @salt, @auth_hash, 0, NULL, @now)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, mode = excluded.mode, salt = excluded.salt,
           auth_hash = excluded.auth_hash, failed_logins = 0, locked_until = NULL, created_at = excluded.created_at`,
      )
      .run({ ...row, now });
  }

  deletePendingClaim(): void {
    this.db.prepare('DELETE FROM pending_claim WHERE id = 1').run();
  }

  /** While a temporary password is pending it guards the account (the old password does not work), else the owner's. */
  getAuthLock(): AuthLock | undefined {
    return this.getPendingClaim() ?? this.getOwner();
  }

  updateAuthLock(patch: Partial<AuthLock>): void {
    if (this.getPendingClaim()) {
      const sets = Object.keys(patch)
        .map((k) => `${k} = @${k}`)
        .join(', ');
      if (sets) this.db.prepare(`UPDATE pending_claim SET ${sets} WHERE id = 1`).run(patch);
    } else {
      this.updateOwner(patch);
    }
  }

  /**
   * Atomically records a used TOTP step. Returns false when this (or a later) step was already used,
   * so two parallel logins cannot both consume the same code.
   */
  consumeTotpStep(step: number): boolean {
    return (
      this.db.prepare('UPDATE owner SET totp_last_step = ? WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)').run(step, step)
        .changes === 1
    );
  }

  /**
   * Flushes and truncates the WAL so superseded pages (old key wraps, deleted sessions) do not linger
   * on disk after a password change, recovery or wipe. secure_delete zeroes freed space in the main file.
   */
  scrub(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /* --------------------------------------------------------- sessions */

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, privkey_enc, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (@id_hash, @privkey_enc, @created_at, @last_seen_at, @expires_at, @ip, @user_agent)`,
      )
      .run(row);
  }

  getSession(idHash: Buffer): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  }

  touchSession(idHash: Buffer, lastSeenAt: number, ip: string | null): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, ip = ? WHERE id_hash = ?').run(lastSeenAt, ip, idHash);
  }

  deleteSession(idHash: Buffer): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteSessionByPrefix(hexPrefix: string): number {
    if (!/^[0-9a-f]{16}$/.test(hexPrefix)) return 0;
    return this.db.prepare("DELETE FROM sessions WHERE substr(lower(hex(id_hash)), 1, 16) = ?").run(hexPrefix).changes;
  }

  deleteAllSessions(exceptIdHash?: Buffer): number {
    if (exceptIdHash) return this.db.prepare('DELETE FROM sessions WHERE id_hash != ?').run(exceptIdHash).changes;
    return this.db.prepare('DELETE FROM sessions').run().changes;
  }

  deleteExpiredSessions(now: number, idleMs: number): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - idleMs).changes;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC').all() as SessionRow[];
  }

  /* ------------------------------------------------------------ audit */

  /* ---------------------------------------------------------------- stories */

  getStoryUser(id: string): StoryUserRow | undefined {
    return this.db.prepare('SELECT * FROM story_users WHERE id = ?').get(id) as StoryUserRow | undefined;
  }

  /** Inserts an author seen in the stories bar, or refreshes the identity fields of a known one. */
  upsertStoryUser(u: { id: string; usernameEnc: Buffer | null; nameEnc: Buffer | null; avatarUrl: string | null; now: number }): void {
    this.db
      .prepare(
        `INSERT INTO story_users (id, username_enc, name_enc, avatar_url, last_story_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username_enc = COALESCE(excluded.username_enc, story_users.username_enc),
           name_enc = COALESCE(excluded.name_enc, story_users.name_enc),
           avatar_url = COALESCE(excluded.avatar_url, story_users.avatar_url),
           updated_at = excluded.updated_at`,
      )
      .run(u.id, u.usernameEnc, u.nameEnc, u.avatarUrl, u.now, u.now);
  }

  markStoryUserCaptured(id: string, latest: number, now: number): void {
    this.db
      .prepare('UPDATE story_users SET last_story_at = MAX(COALESCE(last_story_at, 0), ?), updated_at = ? WHERE id = ?')
      .run(latest, now, id);
  }

  setStoryUserAvatar(id: string, mediaId: number | null, checkedAt: number): void {
    this.db.prepare('UPDATE story_users SET avatar_media_id = ?, avatar_checked_at = ? WHERE id = ?').run(mediaId, checkedAt, id);
  }

  /** Authors with logged stories (what the Stories page lists first), newest activity first. */
  listStoryUsers(): StoryUserListRow[] {
    return this.db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM stories s WHERE s.user_id = u.id) AS count,
           (SELECT MAX(s.taken_at) FROM stories s WHERE s.user_id = u.id) AS latest
         FROM story_users u
         WHERE EXISTS (SELECT 1 FROM stories s WHERE s.user_id = u.id)
         ORDER BY latest DESC`,
      )
      .all() as StoryUserListRow[];
  }

  /** Every author known from the stories bar, for choosing whose stories are logged. */
  listKnownStoryUsers(): StoryUserListRow[] {
    return this.db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM stories s WHERE s.user_id = u.id) AS count,
           (SELECT MAX(s.taken_at) FROM stories s WHERE s.user_id = u.id) AS latest
         FROM story_users u
         ORDER BY u.last_story_at DESC, u.updated_at DESC`,
      )
      .all() as StoryUserListRow[];
  }

  /** Authors whose avatar still has to be fetched (or refreshed after a day). */
  storyUsersNeedingAvatar(olderThan: number, limit: number): StoryUserRow[] {
    return this.db
      .prepare(
        'SELECT * FROM story_users WHERE avatar_url IS NOT NULL AND (avatar_checked_at IS NULL OR avatar_checked_at < ?) ORDER BY updated_at DESC LIMIT ?',
      )
      .all(olderThan, limit) as StoryUserRow[];
  }

  getStory(id: string): StoryRow | undefined {
    return this.db.prepare('SELECT * FROM stories WHERE id = ?').get(id) as StoryRow | undefined;
  }

  /** Stores a story unless it is already known (the same item comes back on every pass until it expires). */
  insertStory(row: Omit<StoryRow, 'attempts' | 'captured_at'> & { capturedAt?: number }): boolean {
    const now = row.capturedAt ?? Date.now();
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO stories (id, user_id, type, taken_at, expires_at, media_id, mime_enc, likes, plays, status, attempts, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(row.id, row.user_id, row.type, row.taken_at, row.expires_at, row.media_id, row.mime_enc, row.likes, row.plays, row.status, now);
    return r.changes > 0;
  }

  setStoryMedia(id: string, mediaId: number | null, mimeEnc: Buffer | null, status: StoryRow['status']): void {
    this.db
      .prepare('UPDATE stories SET media_id = ?, mime_enc = ?, status = ?, attempts = attempts + 1 WHERE id = ?')
      .run(mediaId, mimeEnc, status, id);
  }

  pendingStories(limit: number): StoryRow[] {
    return this.db
      .prepare("SELECT * FROM stories WHERE status = 'pending' AND attempts < 3 ORDER BY taken_at DESC LIMIT ?")
      .all(limit) as StoryRow[];
  }

  /** Stories by status, for the status line. */
  countStoriesByStatus(): { total: number; pending: number; downloaded: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM stories GROUP BY status').all() as { status: string; n: number }[];
    const at = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { total: rows.reduce((a, r) => a + r.n, 0), pending: at('pending'), downloaded: at('downloaded') };
  }

  listStories(q: { userId?: string | null; before?: number | null; limit: number }): StoryRow[] {
    const args: unknown[] = [];
    let where = '1 = 1';
    if (q.userId) {
      where += ' AND user_id = ?';
      args.push(q.userId);
    }
    if (q.before) {
      where += ' AND taken_at < ?';
      args.push(q.before);
    }
    args.push(q.limit);
    return this.db.prepare(`SELECT * FROM stories WHERE ${where} ORDER BY taken_at DESC, id DESC LIMIT ?`).all(...args) as StoryRow[];
  }

  /** Ids and media of the stories older than [before] (the retention sweep deletes the files as well). */
  storiesOlderThan(before: number): { id: string; media_id: number | null }[] {
    return this.db.prepare('SELECT id, media_id FROM stories WHERE taken_at < ?').all(before) as { id: string; media_id: number | null }[];
  }

  deleteStory(id: string): void {
    this.db.prepare('DELETE FROM stories WHERE id = ?').run(id);
  }

  audit(event: string, ip: string | null, detail?: string | null, ts = Date.now()): void {
    this.db.prepare('INSERT INTO audit_log (ts, event, ip, detail) VALUES (?, ?, ?, ?)').run(ts, event, ip, detail ?? null);
    // Keep the audit log bounded.
    this.db.prepare('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) - 5000 FROM audit_log)').run();
  }

  listAudit(limit: number, beforeId?: number): AuditRow[] {
    if (beforeId) {
      return this.db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit) as AuditRow[];
    }
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as AuditRow[];
  }

  /* -------------------------------------------------------- data keys */

  insertDataKey(ephPub: Buffer, wrapped: Buffer, createdAt: number): number {
    const r = this.db.prepare('INSERT INTO data_keys (eph_pub, wrapped, created_at) VALUES (?, ?, ?)').run(ephPub, wrapped, createdAt);
    return Number(r.lastInsertRowid);
  }

  getDataKey(id: number): WrappedDek | undefined {
    const r = this.db.prepare('SELECT eph_pub, wrapped FROM data_keys WHERE id = ?').get(id) as
      | { eph_pub: Buffer; wrapped: Buffer }
      | undefined;
    return r ? { ephPub: r.eph_pub, wrapped: r.wrapped } : undefined;
  }

  /* ------------------------------------------------------------ media */

  insertMedia(row: Omit<MediaRow, 'id'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO media (path, key_id, mime_enc, filename_enc, size, kind, created_at)
         VALUES (@path, @key_id, @mime_enc, @filename_enc, @size, @kind, @created_at)`,
      )
      .run(row);
    return Number(r.lastInsertRowid);
  }

  getMedia(id: number): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  }

  deleteMedia(id: number): void {
    this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
  }

  allMediaPaths(): string[] {
    return (this.db.prepare('SELECT path FROM media').all() as { path: string }[]).map((r) => r.path);
  }

  /* ------------------------------------------------------------ chats */

  getChat(id: string): ChatRow | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  }

  upsertChat(c: {
    id: string;
    kind: string;
    thread_id?: string | null;
    peer_id?: string | null;
    name_enc?: Buffer | null;
    last_ts?: number | null;
    /** undefined: keep; null: inbox; string: TikTok folder. */
    folder?: string | null;
    pinned?: boolean;
    muted?: boolean;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, kind, thread_id, peer_id, name_enc, last_ts, folder, pinned, muted, created_at, updated_at)
         VALUES (@id, @kind, @thread_id, @peer_id, @name_enc, @last_ts, @folder, @pinned, @muted, @now, @now)
         ON CONFLICT (id) DO UPDATE SET
           kind = excluded.kind,
           thread_id = COALESCE(excluded.thread_id, chats.thread_id),
           peer_id = COALESCE(excluded.peer_id, chats.peer_id),
           name_enc = COALESCE(excluded.name_enc, chats.name_enc),
           last_ts = MAX(COALESCE(chats.last_ts, 0), COALESCE(excluded.last_ts, 0)),
           folder = CASE WHEN @has_folder THEN excluded.folder ELSE chats.folder END,
           pinned = CASE WHEN @has_pinned THEN excluded.pinned ELSE chats.pinned END,
           muted = CASE WHEN @has_muted THEN excluded.muted ELSE chats.muted END,
           removed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: c.id,
        kind: c.kind,
        thread_id: c.thread_id ?? null,
        peer_id: c.peer_id ?? null,
        name_enc: c.name_enc ?? null,
        last_ts: c.last_ts ?? null,
        folder: c.folder ?? null,
        pinned: c.pinned ? 1 : 0,
        muted: c.muted ? 1 : 0,
        has_folder: c.folder === undefined ? 0 : 1,
        has_pinned: c.pinned === undefined ? 0 : 1,
        has_muted: c.muted === undefined ? 0 : 1,
        now: c.now,
      });
  }

  bumpChatTs(id: string, ts: number, now: number): void {
    this.db.prepare('UPDATE chats SET last_ts = MAX(COALESCE(last_ts, 0), ?), updated_at = ? WHERE id = ?').run(ts, now, id);
  }

  markChatRemoved(id: string, at: number): void {
    this.db.prepare('UPDATE chats SET removed_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  }

  setChatFlags(id: string, patch: { folder?: string | null; pinned?: boolean; muted?: boolean }, now: number): void {
    if (patch.folder !== undefined) this.db.prepare('UPDATE chats SET folder = ?, updated_at = ? WHERE id = ?').run(patch.folder, now, id);
    if (patch.pinned !== undefined) this.db.prepare('UPDATE chats SET pinned = ?, updated_at = ? WHERE id = ?').run(patch.pinned ? 1 : 0, now, id);
    if (patch.muted !== undefined) this.db.prepare('UPDATE chats SET muted = ?, updated_at = ? WHERE id = ?').run(patch.muted ? 1 : 0, now, id);
  }

  setChatName(id: string, nameEnc: Buffer | null, now: number): void {
    this.db.prepare('UPDATE chats SET name_enc = ?, updated_at = ? WHERE id = ?').run(nameEnc, now, id);
  }

  /** Forgets the chat avatar check so the next refresh fetches the picture again. */
  resetChatAvatarCheck(id: string): void {
    this.db.prepare('UPDATE chats SET avatar_checked_at = NULL WHERE id = ?').run(id);
  }

  setChatAvatar(id: string, mediaId: number | null, checkedAt: number): void {
    this.db.prepare('UPDATE chats SET avatar_media_id = ?, avatar_checked_at = ? WHERE id = ?').run(mediaId, checkedAt, id);
  }

  chatsNeedingAvatar(olderThan: number, limit: number): ChatRow[] {
    return this.db
      .prepare('SELECT * FROM chats WHERE avatar_checked_at IS NULL OR avatar_checked_at < ? ORDER BY last_ts DESC LIMIT ?')
      .all(olderThan, limit) as ChatRow[];
  }

  listChats(): ChatListRow[] {
    return this.db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NOT NULL) AS deleted_count,
           (SELECT m.id FROM messages m WHERE m.chat_id = c.id ORDER BY m.ts DESC, m.rowid DESC LIMIT 1) AS lm_id
         FROM chats c
         ORDER BY c.pinned DESC, COALESCE(c.last_ts, 0) DESC`,
      )
      .all() as ChatListRow[];
  }

  getChatsByIds(ids: string[]): ChatRow[] {
    if (ids.length === 0) return [];
    const out: ChatRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT * FROM chats WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as ChatRow[]));
    }
    return out;
  }

  /* --------------------------------------------------------- contacts */

  getContact(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  getContactsByIds(ids: string[]): ContactRow[] {
    if (ids.length === 0) return [];
    const out: ContactRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT * FROM contacts WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as ContactRow[]));
    }
    return out;
  }

  upsertContact(c: {
    id: string;
    user_id?: string | null;
    username_enc?: Buffer | null;
    name_enc?: Buffer | null;
    is_me?: boolean;
    is_verified?: boolean;
    now: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contacts (id, user_id, username_enc, name_enc, is_me, is_verified, updated_at)
         VALUES (@id, @user_id, @username_enc, @name_enc, @is_me, @is_verified, @now)
         ON CONFLICT (id) DO UPDATE SET
           user_id = COALESCE(excluded.user_id, contacts.user_id),
           username_enc = COALESCE(excluded.username_enc, contacts.username_enc),
           name_enc = COALESCE(excluded.name_enc, contacts.name_enc),
           is_me = MAX(contacts.is_me, excluded.is_me),
           is_verified = MAX(contacts.is_verified, excluded.is_verified),
           updated_at = excluded.updated_at`,
      )
      .run({
        id: c.id,
        user_id: c.user_id ?? null,
        username_enc: c.username_enc ?? null,
        name_enc: c.name_enc ?? null,
        is_me: c.is_me ? 1 : 0,
        is_verified: c.is_verified ? 1 : 0,
        now: c.now,
      });
  }

  meContactIds(): string[] {
    return (this.db.prepare('SELECT id FROM contacts WHERE is_me = 1').all() as { id: string }[]).map((r) => r.id);
  }

  setContactAvatar(id: string, mediaId: number | null, checkedAt: number): void {
    this.db.prepare('UPDATE contacts SET avatar_media_id = ?, avatar_checked_at = ? WHERE id = ?').run(mediaId, checkedAt, id);
  }

  /* --------------------------------------------------------- messages */

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }

  /** By our id or TikTok's other id for the message. */
  findMessage(id: string): MessageRow | undefined {
    return (
      this.getMessage(id) ??
      (this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE alt_id = ? LIMIT 1`).get(id) as MessageRow | undefined)
    );
  }

  /** The row stored for this exact content (the DOM's view and the network's view of one message). */
  messageByDedupe(chatId: string, key: string): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND dedupe_key = ? LIMIT 1`).get(chatId, key) as
      | MessageRow
      | undefined;
  }

  /**
   * A message captured from the page (synthetic id, possibly without a real timestamp) that the network record is
   * probably the same as: same chat, same sender, within [windowMs]. Only returned when exactly one candidate exists,
   * so two identical messages are never merged by accident.
   */
  findSyntheticTwin(chatId: string, ts: number, fromMe: boolean, windowMs = 5 * 60_000): MessageRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND from_me = ? AND instr(id, 'srv:') = 1
           AND deleted_at IS NULL AND ts BETWEEN ? AND ? LIMIT 3`,
      )
      .all(chatId, fromMe ? 1 : 0, ts - windowMs, ts + windowMs) as MessageRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  getMessagesByIds(ids: string[]): MessageRow[] {
    if (ids.length === 0) return [];
    const out: MessageRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...(this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as MessageRow[]));
    }
    return out;
  }

  /** The message and its album parts ("<id>~1", "<id>~2", …). */
  messageWithParts(id: string): MessageRow[] {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ? OR (substr(id, 1, length(?) + 1) = ? || '~') ORDER BY album_index`)
      .all(id, id, id) as MessageRow[];
  }

  /** Own messages up to [ts] were seen by the other side. Returns the ids that changed. */
  markSeenUpTo(chatId: string, ts: number, now: number): string[] {
    const ids = (
      this.db
        .prepare(`SELECT id FROM messages WHERE chat_id = ? AND from_me = 1 AND ts <= ? AND (ack IS NULL OR ack < 3) AND deleted_at IS NULL`)
        .all(chatId, ts) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length) this.db.prepare('UPDATE messages SET ack = 3, updated_at = ? WHERE chat_id = ? AND from_me = 1 AND ts <= ? AND (ack IS NULL OR ack < 3)').run(now, chatId, ts);
    return ids;
  }

  /** Ids of live (not deleted) messages of a chat within [fromTs, toTs], without album parts. */
  messageIdsBetween(chatId: string, fromTs: number, toTs: number): { id: string; ts: number }[] {
    return this.db
      .prepare(`SELECT id, ts FROM messages WHERE chat_id = ? AND ts >= ? AND ts <= ? AND deleted_at IS NULL AND instr(id, '~') = 0`)
      .all(chatId, fromTs, toTs) as { id: string; ts: number }[];
  }

  /** The first message of the chat after [ts] (for re-fetching a page that contains an older message). */
  nextMessageAfter(chatId: string, ts: number): MessageRow | undefined {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND ts > ? AND instr(id, '~') = 0 ORDER BY ts ASC, rowid ASC LIMIT 1`)
      .get(chatId, ts) as MessageRow | undefined;
  }

  /** Inserts if absent. Returns true when a row was inserted. */
  insertMessage(m: NewMessage): boolean {
    const cols = Object.keys(m);
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`)
      .run(m);
    return r.changes === 1;
  }

  updateMessage(id: string, patch: Partial<MessageRow>): void {
    const { sets, values } = buildUpdate(MESSAGE_UPDATABLE, patch);
    if (!sets) return;
    this.db.prepare(`UPDATE messages SET ${sets} WHERE id = ?`).run(...values, id);
  }

  /** Newest-first page older than `before`, returned in ascending order. */
  listMessagesBefore(chatId: string, before: Cursor | null, limit: number): MessageRow[] {
    const rows = before
      ? (this.db
          .prepare(
            `SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND (ts < ? OR (ts = ? AND rowid < ?))
             ORDER BY ts DESC, rowid DESC LIMIT ?`,
          )
          .all(chatId, before.ts, before.ts, before.rowid, limit) as MessageRow[])
      : (this.db
          .prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
          .all(chatId, limit) as MessageRow[]);
    return rows.reverse();
  }

  /** Oldest-first page newer than `after` (exclusive). */
  listMessagesAfter(chatId: string, after: Cursor, limit: number): MessageRow[] {
    return this.db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND (ts > ? OR (ts = ? AND rowid > ?))
         ORDER BY ts ASC, rowid ASC LIMIT ?`,
      )
      .all(chatId, after.ts, after.ts, after.rowid, limit) as MessageRow[];
  }

  listDeleted(before: Cursor | null, limit: number): MessageRow[] {
    if (before) {
      return this.db
        .prepare(
          `SELECT ${MSG_COLS} FROM messages WHERE deleted_at IS NOT NULL AND (deleted_at < ? OR (deleted_at = ? AND rowid < ?))
           ORDER BY deleted_at DESC, rowid DESC LIMIT ?`,
        )
        .all(before.ts, before.ts, before.rowid, limit) as MessageRow[];
    }
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as MessageRow[];
  }

  /** Messages whose media was downloaded after media id `after`, in download (media id) order. */
  listDownloadedMediaAfter(after: number, limit: number): MessageRow[] {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE media_id > ? AND media_status = 'downloaded' ORDER BY media_id LIMIT ?`)
      .all(after, limit) as MessageRow[];
  }

  getMessageByMediaId(mediaId: number): MessageRow | undefined {
    return this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE media_id = ?`).get(mediaId) as MessageRow | undefined;
  }

  maxMessageMediaId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(media_id), 0) AS m FROM messages').get() as { m: number }).m;
  }

  /** Batch of messages with a body/meta for search scanning, newest first. */
  scanForSearch(chatId: string | null, before: Cursor | null, limit: number): MessageRow[] {
    const where: string[] = ['(body_enc IS NOT NULL OR meta_enc IS NOT NULL)'];
    const args: unknown[] = [];
    if (chatId) {
      where.push('chat_id = ?');
      args.push(chatId);
    }
    if (before) {
      where.push('(ts < ? OR (ts = ? AND rowid < ?))');
      args.push(before.ts, before.ts, before.rowid);
    }
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...args, limit) as MessageRow[];
  }

  pendingMediaMessages(limit: number): MessageRow[] {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE media_status = 'pending' ORDER BY ts DESC LIMIT ?`)
      .all(limit) as MessageRow[];
  }

  countPendingMedia(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE media_status = 'pending'`).get() as { n: number }).n;
  }

  /* ------------------------------------------------------------ edits */

  insertEdit(messageId: string, bodyEnc: Buffer | null, capturedAt: number): void {
    this.db.prepare('INSERT INTO message_edits (message_id, body_enc, captured_at) VALUES (?, ?, ?)').run(messageId, bodyEnc, capturedAt);
  }

  listEdits(messageId: string): EditRow[] {
    return this.db.prepare('SELECT * FROM message_edits WHERE message_id = ? ORDER BY id ASC').all(messageId) as EditRow[];
  }

  editCounts(messageIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < messageIds.length; i += 500) {
      const part = messageIds.slice(i, i + 500);
      if (part.length === 0) continue;
      const rows = this.db
        .prepare(`SELECT message_id, COUNT(*) AS n FROM message_edits WHERE message_id IN (${part.map(() => '?').join(',')}) GROUP BY message_id`)
        .all(...part) as { message_id: string; n: number }[];
      for (const r of rows) out.set(r.message_id, r.n);
    }
    return out;
  }

  /* -------------------------------------------------------- reactions */

  upsertReaction(r: { message_id: string; sender_id: string; emoji_enc: Buffer | null; ts: number; removed: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO reactions (message_id, sender_id, emoji_enc, ts, removed_at)
         VALUES (@message_id, @sender_id, @emoji_enc, @ts, @removed_at)
         ON CONFLICT (message_id, sender_id) DO UPDATE SET
           emoji_enc = COALESCE(excluded.emoji_enc, reactions.emoji_enc),
           ts = excluded.ts,
           removed_at = excluded.removed_at
         WHERE excluded.ts >= reactions.ts`,
      )
      .run({ ...r, removed_at: r.removed ? r.ts : null });
  }

  reactionsFor(messageIds: string[]): ReactionRow[] {
    const out: ReactionRow[] = [];
    for (let i = 0; i < messageIds.length; i += 500) {
      const part = messageIds.slice(i, i + 500);
      if (part.length === 0) continue;
      out.push(
        ...(this.db
          .prepare(`SELECT * FROM reactions WHERE message_id IN (${part.map(() => '?').join(',')}) ORDER BY ts ASC`)
          .all(...part) as ReactionRow[]),
      );
    }
    return out;
  }

  /* ------------------------------------------------------------- wipe */

  /**
   * Deletes everything of this account: the logged data AND the owner, sessions and key material, so the next person
   * starts from scratch with new keys (the audit log stays). Returns media paths to unlink.
   */
  resetAccount(): string[] {
    return this.transaction(() => {
      const paths = this.wipeLoggedData();
      this.db.exec(`
        DELETE FROM sessions;
        DELETE FROM data_keys;
        DELETE FROM owner;
        DELETE FROM app_state;
        DELETE FROM pending_claim;
      `);
      return paths;
    });
  }

  /** Deletes all logged TikTok data (keeps owner, sessions, audit, settings). Returns media paths to unlink. */
  wipeLoggedData(): string[] {
    return this.transaction(() => {
      const paths = this.allMediaPaths();
      this.db.exec(`
        DELETE FROM reactions;
        DELETE FROM message_edits;
        DELETE FROM messages;
        DELETE FROM contacts;
        DELETE FROM chats;
        DELETE FROM media;
      `);
      return paths;
    });
  }
}
