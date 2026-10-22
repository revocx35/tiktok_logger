import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppContext } from '../context.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { EventBus } from '../events.js';
import { createLogger } from '../log.js';
import { loadConfig } from '../config.js';
import { SettingsStore } from '../settings.js';
import { Ingest, MediaSources } from './ingest.js';
import { domRowToMessage, mapMessage } from './mapper.js';
import type { TtMessage } from './types.js';

/** Ingest against a real (in-memory-ish, temporary) encrypted database — the same code the worker runs. */
describe('Ingest', () => {
  let dir: string;
  let ctx: AppContext;
  let sources: MediaSources;
  let queued: { id: string; priority: string }[];
  let ingest: Ingest;

  const ME = '7000000000000000001';
  const PEER = '7000000000000000042';
  const CHAT = 'conv-1';
  const NOW = Date.now();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttl-ingest-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dir,
      SCRYPT_LOG_N: '10',
      TT_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    const repo = new Repo(openDb(config.dbPath));
    const events = new EventBus();
    ctx = new AppContext(config, createLogger('silent'), repo, events, new SettingsStore(repo, config.defaults));
    await makeOwner(ctx);
    sources = new MediaSources();
    queued = [];
    ingest = new Ingest(ctx, events, sources, { enqueue: (id, priority) => queued.push({ id, priority }) });
    ingest.me = { id: ME, username: 'owner', name: 'Owner' };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const msg = (over: Partial<TtMessage> = {}): TtMessage => ({
    id: 'srv-1',
    threadId: CHAT,
    senderId: PEER,
    fromMe: false,
    ts: NOW - 60_000,
    type: 'text',
    text: 'hello',
    media: [],
    source: 'live',
    ...over,
  });

  it('stores a message, its chat and its contact encrypted', () => {
    ingest.thread({ id: CHAT, kind: 'user', peerId: PEER, name: 'Ali' });
    const id = ingest.message(msg(), 'live');
    expect(id).toBe('srv-1');
    const row = ctx.repo.getMessage('srv-1')!;
    expect(row.chat_id).toBe(CHAT);
    expect(row.from_me).toBe(0);
    expect(row.body_enc).not.toBeNull();
    // Nothing readable in the database file itself.
    const raw = require('node:fs').readFileSync(ctx.config.dbPath) as Buffer;
    expect(raw.includes(Buffer.from('hello'))).toBe(false);
    expect(raw.includes(Buffer.from('Ali'))).toBe(false);
    expect(ctx.repo.getChat(CHAT)!.last_ts).toBe(NOW - 60_000);
  });

  it('merges the DOM view and the network view of one message', () => {
    // The page was read first: no server id, no precise time.
    const domMsg = domRowToMessage(CHAT, { i: 0, text: 'hello', mine: false, ts: NOW - 58_000 }, { meId: ME, now: NOW })!;
    const domId = ingest.message(domMsg, 'dom')!;
    expect(domId.startsWith('srv:')).toBe(true);

    // Later the same message arrives through TikTok's own answer, with its server id.
    const live = mapMessage(
      { conversation_id: CHAT, server_message_id: 'srv-2', sender: { uid: PEER }, content: '{"text":"hello"}', create_time: Math.floor((NOW - 58_000) / 1000) },
      null,
      { meId: ME, now: NOW },
    )!;
    const netId = ingest.message(live, 'live')!;
    // One row: the page's row got the server id as its alternate id.
    expect(ctx.repo.listMessagesBefore(CHAT, null, 10)).toHaveLength(1);
    expect(netId).toBe(domId);
    const row = ctx.repo.getMessage(domId)!;
    expect(row.alt_id).toBe('srv-2');
    expect(ctx.repo.findMessage('srv-2')!.id).toBe(domId);
    expect(row.source).toBe('live');
  });

  it('stores a message with several photos as album parts', () => {
    const m = msg({
      id: 'srv-3',
      type: 'media',
      text: null,
      media: [
        { url: 'https://p16.tiktokcdn.com/1.jpg', kind: 'image', width: 100, height: 200 },
        { url: 'https://p16.tiktokcdn.com/2.jpg', kind: 'image', width: 300, height: 400 },
      ],
    });
    ingest.message(m, 'live');
    const rows = ctx.repo.messageWithParts('srv-3');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.album_index).toBe(0);
    expect(rows[1]!.id).toBe('srv-3~1');
    expect(rows.every((r) => r.media_status === 'pending')).toBe(true);
    expect(queued.map((q) => q.id).sort()).toEqual(['srv-3', 'srv-3~1']);
    expect(sources.get('srv-3~1')!.url).toBe('https://p16.tiktokcdn.com/2.jpg');
  });

  it('does not store the same message twice', () => {
    ingest.message(msg(), 'live');
    ingest.message(msg(), 'live');
    ingest.message(msg({ id: 'other-id-same-content' }), 'live');
    expect(ctx.repo.listMessagesBefore(CHAT, null, 10)).toHaveLength(1);
  });

  it('flags messages that vanished from a re-read as missing', () => {
    const t0 = NOW - 600_000;
    for (let i = 0; i < 3; i++) ingest.message(msg({ id: `srv-a${i}`, ts: t0 + i * 60_000, text: `m${i}` }), 'history');
    // The page now shows only the first and the third: the second was unsent.
    const seen = new Set(['srv-a0', 'srv-a2']);
    const n = ingest.markMissing(CHAT, seen, t0, t0 + 120_000, NOW);
    expect(n).toBe(1);
    expect(ctx.repo.getMessage('srv-a1')!.deleted_by).toBe('missing');
  });

  it('never judges a message younger than a minute (it may still be uploading)', () => {
    ingest.message(msg({ id: 'srv-b', ts: NOW - 5_000 }), 'live');
    expect(ingest.markMissing(CHAT, new Set(), NOW - 10_000, NOW, NOW)).toBe(0);
    expect(ctx.repo.getMessage('srv-b')!.deleted_at).toBeNull();
  });

  it('records an explicit unsend once', () => {
    ingest.message(msg({ id: 'srv-c' }), 'live');
    expect(ingest.unsend('srv-c', 'sender', NOW)).toBe(true);
    expect(ingest.unsend('srv-c', 'sender', NOW)).toBe(false);
    expect(ctx.repo.getMessage('srv-c')!.deleted_by).toBe('sender');
  });

  it('keeps reactions and their removal', () => {
    ingest.message(msg({ id: 'srv-d' }), 'live');
    ingest.reaction('srv-d', { senderId: PEER, emoji: '❤️', ts: NOW });
    expect(ctx.repo.reactionsFor(['srv-d']).filter((r) => !r.removed_at)).toHaveLength(1);
    ingest.reaction('srv-d', { senderId: PEER, emoji: '❤️', ts: NOW + 1000, removed: true });
    expect(ctx.repo.reactionsFor(['srv-d']).filter((r) => !r.removed_at)).toHaveLength(0);
  });

  it('marks own messages with the account id', () => {
    ingest.message(msg({ id: 'srv-e', fromMe: true, senderId: ME }), 'sent');
    const row = ctx.repo.getMessage('srv-e')!;
    expect(row.from_me).toBe(1);
    expect(row.sender_id).toBe(ME);
  });

});

/** An owner with a real X25519 key pair (the writer needs the public key to wrap data keys). */
async function makeOwner(ctx: AppContext): Promise<void> {
  const { PRIVKEY_AAD, generateX25519, wrapPrivateKey } = await import('../crypto/keyring.js');
  const { derivePasswordKeys, deriveRecoveryKeys, generateRecoveryKey, newSalt } = await import('../crypto/password.js');
  const pwSalt = newSalt();
  const pw = await derivePasswordKeys('correct-horse-battery-staple', pwSalt, 10);
  const kp = generateX25519();
  const recovery = generateRecoveryKey();
  const recoverySalt = newSalt();
  const rk = deriveRecoveryKeys(recovery.bytes, recoverySalt);
  const now = Date.now();
  ctx.repo.createOwner({
    username: 'owner',
    pw_salt: pwSalt,
    pw_auth_hash: pw.authHash,
    public_key: kp.publicRaw,
    privkey_pw: wrapPrivateKey(pw.kek, kp.privatePkcs8, PRIVKEY_AAD.password),
    privkey_recovery: wrapPrivateKey(rk.kek, kp.privatePkcs8, PRIVKEY_AAD.recovery),
    recovery_salt: recoverySalt,
    recovery_auth_hash: rk.authHash,
    created_at: now,
    password_changed_at: now,
  });
  pw.kek.fill(0);
  rk.kek.fill(0);
  kp.privatePkcs8.fill(0);
}
