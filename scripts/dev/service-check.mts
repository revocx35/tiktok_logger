/**
 * End-to-end check of the TikTok integration without Docker: the real `TtService` against the fake TikTok in a local
 * Chromium, with a real encrypted database.
 *
 * It proves the whole path: login detection → page reading → conversation import → encrypted storage → sending →
 * a message arriving through the captured network stream → unsent messages noticed by a re-check.
 *
 *   cd server && PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx tsx ../scripts/dev/service-check.mts
 *
 * Not part of `npm test` (no browser in the app image); `scripts/smoke.sh` covers the containers.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/src/config.js';
import { AppContext } from '../../server/src/context.js';
import { PRIVKEY_AAD, DataReader, generateX25519, wrapPrivateKey } from '../../server/src/crypto/keyring.js';
import { derivePasswordKeys, deriveRecoveryKeys, generateRecoveryKey, newSalt } from '../../server/src/crypto/password.js';
import { openDb } from '../../server/src/db/db.js';
import { Repo } from '../../server/src/db/repo.js';
import { EventBus } from '../../server/src/events.js';
import { createLogger } from '../../server/src/log.js';
import { SettingsStore } from '../../server/src/settings.js';
import { TtService } from '../../server/src/tt/service.js';
import { startFakeTikTok } from './fake-tiktok.mts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const puppeteer = requireFromServer('puppeteer') as typeof import('puppeteer');

const ME = '7000000000000000001';
const CHAT = 'conv-ali';
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(300);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttl-e2e-'));
const fake = await startFakeTikTok({});
const browser = await (puppeteer as unknown as { launch: (o: unknown) => Promise<import('puppeteer').Browser> }).launch({
  headless: true,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    SCRYPT_LOG_N: '10',
    LOG_LEVEL: 'warn',
    TT_ENABLED: 'true',
    TT_WEB_ORIGIN: fake.url,
    TT_REQUEST_GAP_MS: '20',
    HISTORY_PER_CHAT: '50',
  } as NodeJS.ProcessEnv);
  const repo = new Repo(openDb(config.dbPath));
  const events = new EventBus();
  const ctx = new AppContext(config, createLogger('warn'), repo, events, new SettingsStore(repo, config.defaults));

  // An owner with a key pair, so the writer can encrypt (the private key is kept to read the data back).
  const pwSalt = newSalt();
  const pw = await derivePasswordKeys('correct-horse-battery-staple', pwSalt, 10);
  const kp = generateX25519();
  const recovery = generateRecoveryKey();
  const recoverySalt = newSalt();
  const rk = deriveRecoveryKeys(recovery.bytes, recoverySalt);
  const now = Date.now();
  repo.createOwner({
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
  const reader = DataReader.fromPkcs8(repo, Buffer.from(kp.privatePkcs8));
  const bodyOf = (id: string): string | null => {
    const row = repo.getMessage(id);
    return row ? reader.tryText('msgbody', 'body', id, row.body_enc) : null;
  };

  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.goto(`${fake.url}/messages`, { waitUntil: 'domcontentloaded' });
  const service = new TtService(ctx, async () => ({ browser, page }));
  ctx.tt = service;

  // The fake answers the "who am I" question through its conversation list; the service also reads the cookie jar.
  await service.start();
  const ready = await waitFor('state ready', () => service.status().state === 'ready', 40_000);
  check('the service becomes ready', ready, JSON.stringify(service.status()));

  const chats = repo.listChats();
  check('all three conversations are imported', chats.length === 3, JSON.stringify(chats.map((c) => [c.id, c.kind, c.message_count, c.thread_id])));

  const ali = chats.find((c) => c.id === CHAT);
  check('the chat has its imported messages', (ali?.message_count ?? 0) >= 4, `count=${ali?.message_count}`);
  const texts = repo.listMessagesBefore(CHAT, null, 50).map((m) => bodyOf(m.id)).filter((t): t is string => !!t);
  check('message bodies are readable after decryption', texts.includes('hello there') && texts.includes('did you see this?'), JSON.stringify(texts));

  const photo = repo.listMessagesBefore(CHAT, null, 50).find((m) => m.media_status === 'pending');
  check('media rows are queued for download', !!photo, JSON.stringify(repo.listMessagesBefore(CHAT, null, 50).map((m) => m.media_status)));

  // Sending: drives the composer of the fake page.
  const sent = await service.sender.sendText(CHAT, 'sent from tiktok_logger', null);
  const sentRow = sent.id ? repo.getMessage(sent.id) : undefined;
  check('a sent message is stored as ours', !!sentRow && sentRow.from_me === 1, JSON.stringify(sent));
  check('the sent text round-trips through encryption', !!sentRow && bodyOf(sentRow.id) === 'sent from tiktok_logger');

  // A message arriving through the captured stream: a protobuf frame with a JSON payload inside (TikTok's shape).
  const frame = imFrame({
    conversation_id: 'conv-ayse',
    message_id: 'live-1',
    create_time: Math.floor(Date.now() / 1000),
    sender: { uid: '7000000000000000043', nickname: 'Ayşe' },
    content: JSON.stringify({ text: 'live message from the stream', aweType: 700 }),
  });
  (service as unknown as { onFrame: (b: Buffer) => void }).onFrame(frame);
  const liveStored = await waitFor('the live frame stored', () => !!repo.getMessage('live-1'), 5000);
  check('a message from the stream is stored', liveStored);
  check('the stream message text is intact', liveStored && bodyOf('live-1') === 'live message from the stream');
  check('the stream message landed in its own chat', liveStored && repo.getMessage('live-1')!.chat_id === 'conv-ayse');

  // Anti-delete: the peer unsends a message, the re-check notices it.
  // A message in the middle of the conversation (a deletion at the very top of the visible range is deliberately not
  // judged: the page's oldest row is the boundary of what it rendered).
  const victim = fake.conversations.find((c) => c.conversation_id === CHAT)!.messages.find((m) => JSON.parse(m.content || '{}').text === 'did you see this?')!;
  const before = repo.messageIdsBetween(CHAT, 0, Date.now()).length;
  fake.conversations.find((c) => c.conversation_id === CHAT)!.messages = fake.conversations
    .find((c) => c.conversation_id === CHAT)!
    .messages.filter((m) => m.message_id !== victim.message_id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(500);
  await (service as unknown as { reconcileOnce: () => Promise<void> }).reconcileOnce();
  const gone = repo.listDeleted(null, 50);
  check('the unsent message is kept and flagged', gone.length === 1 && bodyOf(gone[0]!.id) === 'did you see this?' && gone[0]!.deleted_by === 'missing', JSON.stringify(gone.map((g) => [g.id, g.deleted_by, bodyOf(g.id)])));
  const after = repo.messageIdsBetween(CHAT, 0, Date.now()).length;
  check('only the unsent message left the live log', after === before - 1, `before=${before} after=${after}`);

  /* ------------------------------------------------------------------ feed */
  // Same service, second tab: the feed must not disturb the messages tab.
  const feedFirst = await service.feed.current();
  check('the feed opens on the first video', feedFirst?.id === fake.feed[0]!.id, JSON.stringify(feedFirst?.id));
  check('the feed video is served through an app reference', /^\/api\/feed\/media\/[0-9a-f]{24}$/.test(feedFirst?.video?.src ?? ''), JSON.stringify(feedFirst?.video?.src));
  const feedNext = await service.feed.step('next');
  check('the feed moves to the next video', feedNext.id === fake.feed[1]!.id, JSON.stringify(feedNext.id));
  const unliked = await service.feed.like(feedNext.id, false);
  check('un-liking goes through TikTok\'s own control', unliked.liked === false, JSON.stringify(unliked));
  const back = await service.feed.step('prev');
  check('the feed goes back', back.id === fake.feed[0]!.id, JSON.stringify(back.id));
  const feedComments = await service.feed.comments(back.id);
  check('comments are read (with a reply)', feedComments.length === 2 && feedComments[1]!.replies.length === 1, JSON.stringify(feedComments.map((c) => [c.text, c.replies.length])));
  const postedComments = await service.feed.comment(back.id, 'comment from the service check');
  check('a comment is posted', postedComments.some((c) => c.text === 'comment from the service check'), JSON.stringify(postedComments.map((c) => c.text)));

  // The video itself: streamed through the browser into a buffer.
  const src = back.video?.src ?? '';
  const ref = src.split('/').pop() ?? '';
  const chunks: Buffer[] = [];
  const media = await service.feed.streamMedia(ref, async (c) => {
    chunks.push(c);
  });
  const bytes = Buffer.concat(chunks);
  check('the feed video streams through the browser', bytes.length > 0 && !!media.mime, `${bytes.length} bytes, ${media.mime}`);
  await service.feed.closeComments();

  // The messages tab must still be logging after all that.
  const msgsBefore = repo.messageIdsBetween(CHAT, 0, Date.now()).length;
  fake.receive(CHAT, 'still logging after the feed');
  await page.evaluate(async () => {
    // The fake page polls nothing; a reload is what a returning tab does, and the reconcile picks the message up.
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(400);
  await (service as unknown as { reconcileOnce: () => Promise<void> }).reconcileOnce();
  check('the messages tab still logs after using the feed', repo.messageIdsBetween(CHAT, 0, Date.now()).length >= msgsBefore);

  await service.stop();
} finally {
  await browser.close();
  await fake.close();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall service checks passed' : `\n${failures} service check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/** A protobuf frame shaped like TikTok's push: field 8 holds a message envelope with the content JSON in field 4. */
function imFrame(message: Record<string, unknown>): Buffer {
  const content = Buffer.from(JSON.stringify(message));
  const envelope = Buffer.concat([pbField(1, 2, Buffer.from(String(message.conversation_id))), pbField(4, 2, content)]);
  return Buffer.concat([pbField(1, 0, 100), pbField(8, 2, envelope)]);
}

function pbVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function pbField(field: number, wire: number, payload: Buffer | number): Buffer {
  const tag = pbVarint((field << 3) | wire);
  if (wire === 0) return Buffer.concat([tag, pbVarint(payload as number)]);
  const body = payload as Buffer;
  return Buffer.concat([tag, pbVarint(body.length), body]);
}
