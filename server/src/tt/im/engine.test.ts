import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../context.js';
import { Ingest, MediaSources } from '../ingest.js';
import { makeCtx } from '../testutil.js';
import { ImEngine, ImSendError } from './engine.js';
import { PbWriter, num, readFields, str, sub, subs } from './wire.js';
import { COMBO_PATH, HISTORY_PATH, INBOX_PATH, SEND_PATH, type ImEnv } from './proto.js';
import type { ImReply, ImTransport } from './transport.js';

const ME = '7000000000000000001';
const PEER = '7000000000000000042';
const CONV = `0:1:${ME}:${PEER}`;
const SRC = '7646000000000000817';
const NOW_US = BigInt(Date.now()) * 1000n;
const env: ImEnv = { deviceId: '7699000000000000470', msToken: 'tok', verifyFp: '', userAgent: 'UA', language: 'en-US', platform: 'Linux x86_64', tz: 'UTC', region: 'TR', screenW: 1280, screenH: 800, historyLen: 2 };

function row(o: { conv?: string; id: string; tsUs: bigint; sender: string; text?: string; tags?: [string, string][]; source?: string; cursor?: bigint }): PbWriter {
  const w = new PbWriter().string(1, o.conv ?? CONV).u64(3, BigInt(o.id)).u64(4, o.tsUs);
  if (o.source) w.u64(5, BigInt(o.source));
  w.u64(7, BigInt(o.sender)).bytes(8, Buffer.from(JSON.stringify({ aweType: 700, text: o.text ?? 'hi' })));
  for (const [k, v] of o.tags ?? [['s:client_message_id', 'abc']]) w.message(9, new PbWriter().string(1, k).bytes(2, Buffer.from(v)));
  if (o.cursor) w.u64(25, o.cursor);
  return w;
}

const inboxBody = (convs: { id: string; src: string; type: number; members?: string[]; title?: string }[]) => {
  const list = new PbWriter();
  for (const c of convs) {
    const d = new PbWriter().string(1, c.id).u64(2, BigInt(c.src)).u64(3, c.type);
    if (c.members) {
      const m = new PbWriter();
      for (const u of c.members) m.message(1, new PbWriter().u64(1, BigInt(u)));
      d.message(6, m);
    }
    if (c.title) d.message(50, new PbWriter().string(5, c.title));
    list.message(2, d);
  }
  return new PbWriter().u64(1, 203).u64(3, 0).message(6, new PbWriter().message(203, list)).build();
};
const historyBody = (rows: PbWriter[]) => {
  const l = new PbWriter();
  for (const r of rows) l.message(1, r);
  return new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, l)).build();
};
const comboBody = (lane0: PbWriter[], next0: bigint, more = false, lane1: PbWriter[] = []) => {
  const lane = (kind: number, rows: PbWriter[], next: bigint, hasMore: boolean) => {
    const w = new PbWriter().u64(1, kind);
    for (const r of rows) w.message(2, r);
    return w.u64(4, hasMore ? 1 : 0).u64(5, next);
  };
  return new PbWriter().u64(1, 204).message(6, new PbWriter().message(204, new PbWriter().message(1, lane(0, lane0, next0, more)).message(1, lane(1, lane1, next0, false)))).build();
};

class FakeTransport {
  calls: { path: string; body: Buffer; query: Record<string, string>; headers: Record<string, string> }[] = [];
  handlers: Record<string, (body: Buffer, n: number) => Buffer | ImReply | Error> = {};
  profiles: Record<string, { nick: string; unique: string }> = { [PEER]: { nick: 'Ali Veli', unique: 'aliveli' } };
  async env() {
    return { env, uid: ME };
  }
  forget() {}
  async baseQuery() {
    return {};
  }
  async post(path: string, body: Buffer, opts: { query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<ImReply> {
    this.calls.push({ path, body, query: opts.query ?? {}, headers: opts.headers ?? {} });
    const n = this.calls.filter((c) => c.path === path).length;
    const h = this.handlers[path];
    if (!h) throw new Error(`no handler for ${path}`);
    const r = h(body, n);
    if (r instanceof Error) throw r;
    return Buffer.isBuffer(r) ? { status: 200, body: r } : r;
  }
  async getJson(url: string) {
    const ids = JSON.parse(new URL(url).searchParams.get('user_ids')!) as string[];
    return { users: ids.filter((i) => this.profiles[i]).map((i) => ({ im_user_profile: { user_id_str: i, unique_id: this.profiles[i]!.unique, nick_name: this.profiles[i]!.nick, avatars: { avatar_medium: { url_list: [`https://p16.tiktokcdn.com/a${i}.jpeg`] } } } })) };
  }
}

describe('ImEngine', () => {
  let ctx: AppContext;
  let cleanup: () => Promise<void>;
  let ingest: Ingest;
  let t: FakeTransport;
  let engine: ImEngine;
  let queued: string[];
  const dl = { fetch: async (_url: string, _max: number, sink: (c: Buffer) => Promise<void>) => { await sink(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return { status: 'ok' as const, mime: 'image/jpeg', size: 4 }; } };

  beforeEach(async () => {
    const made = await makeCtx();
    ctx = made.ctx;
    cleanup = made.cleanup;
    queued = [];
    ingest = new Ingest(ctx, made.events, new MediaSources(), { enqueue: (id) => queued.push(id) });
    ingest.me = { id: ME, username: 'owner', name: 'Owner' };
    t = new FakeTransport();
    engine = new ImEngine(ctx, ingest, t as unknown as ImTransport, { activity: () => undefined, downloader: () => dl });
  });
  afterEach(async () => {
    await cleanup();
  });

  const standard = () => {
    t.handlers[INBOX_PATH] = (b) => {
      const sub_ = num(readFields(b), 2);
      return sub_ === '10002' ? inboxBody([{ id: '987654321', src: '5555', type: 2, title: 'Study group', members: [ME, PEER] }]) : inboxBody([{ id: CONV, src: SRC, type: 1, members: [ME, PEER] }]);
    };
    t.handlers[HISTORY_PATH] = (b) => {
      const q = sub(sub(readFields(b), 8)!, 301)!;
      return str(q, 1) === CONV
        ? historyBody([row({ id: '7700000000000000002', tsUs: NOW_US - 5_000_000n, sender: ME, text: 'second', cursor: NOW_US - 5_000_000n }), row({ id: '7700000000000000001', tsUs: NOW_US - 60_000_000n, sender: PEER, text: 'first', cursor: NOW_US - 60_000_000n })])
        : historyBody([row({ conv: '987654321', id: '7700000000000000009', tsUs: NOW_US - 30_000_000n, sender: PEER, text: 'group hello' })]);
    };
    t.handlers[COMBO_PATH] = () => comboBody([], NOW_US - 200_000_000n);
  };

  it('imports the conversations, their latest messages and names the chats from the profiles', async () => {
    standard();
    const progress: [number, number][] = [];
    await engine.initialImport((d, n) => progress.push([d, n]));
    const chats = ctx.repo.listChats();
    expect(chats.map((c) => c.id).sort()).toEqual(['987654321', CONV].sort());
    expect(ctx.repo.getChat(CONV)).toMatchObject({ kind: 'user', peer_id: PEER });
    expect(ctx.repo.getChat(CONV)!.name_enc).not.toBeNull();
    expect(ctx.repo.getChat('987654321')).toMatchObject({ kind: 'group' });
    const m = ctx.repo.getMessage('7700000000000000002')!;
    expect(m).toMatchObject({ chat_id: CONV, from_me: 1, type: 'text' });
    expect(ctx.repo.getMessage('7700000000000000001')).toMatchObject({ from_me: 0, sender_id: PEER });
    expect(ctx.repo.getMessage('7700000000000000009')).toMatchObject({ chat_id: '987654321' });
    expect(progress.at(-1)).toEqual([2, 2]);
    expect(ctx.repo.getState('im_imported')).toBe('1');
    // The first import starts the all-conversations feed 30 days back, not at the beginning of time.
    const first = t.calls.find((c) => c.path === COMBO_PATH)!;
    const lane = subs(sub(sub(readFields(first.body), 8)!, 204)!, 1)[0]!;
    const ageDays = (Number(NOW_US) - Number(num(lane, 2))) / 86400e6;
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
  });

  it('does not re-read every conversation after a restart: only the catch-up runs', async () => {
    standard();
    await engine.initialImport(() => undefined);
    engine.flush();
    const again = new ImEngine(ctx, ingest, t as unknown as ImTransport, { activity: () => undefined });
    t.calls = [];
    await again.initialImport(() => undefined);
    expect(t.calls.filter((c) => c.path === HISTORY_PATH)).toHaveLength(0);
    expect(t.calls.some((c) => c.path === COMBO_PATH)).toBe(true);
  });

  it('catches up with new messages, pages while there are more, advances and rewinds the cursor, and never stores a row twice', async () => {
    standard();
    await engine.initialImport(() => undefined);
    const r1 = row({ conv: CONV, id: '7700000000000000010', tsUs: NOW_US - 2_000_000n, sender: PEER, source: SRC, text: 'ping' });
    const r2 = row({ conv: CONV, id: '7700000000000000011', tsUs: NOW_US - 1_000_000n, sender: PEER, source: SRC, text: 'pong' });
    t.handlers[COMBO_PATH] = (_b, n) => (n % 2 === 1 ? comboBody([r1], NOW_US - 2_000_000n, true) : comboBody([r2], NOW_US - 1_000_000n, false));
    t.calls = [];
    expect(await engine.catchUp('live')).toBe(2);
    expect(ctx.repo.getMessage('7700000000000000010')).toMatchObject({ chat_id: CONV });
    expect(ctx.repo.getMessage('7700000000000000011')).toMatchObject({ chat_id: CONV });
    expect(t.calls.filter((c) => c.path === COMBO_PATH)).toHaveLength(2);
    // The second page continued from the first page's cursor.
    const c2 = subs(sub(sub(readFields(t.calls[1]!.body), 8)!, 204)!, 1)[0]!;
    expect(num(c2, 2)).toBe((NOW_US - 2_000_000n).toString());
    // The same rows again (the next poll re-reads the last 90 s): nothing is stored twice.
    t.handlers[COMBO_PATH] = () => comboBody([r1, r2], NOW_US - 1_000_000n, false);
    t.calls = [];
    await engine.catchUp('live');
    const count = ctx.repo.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(CONV) as { n: number };
    expect(count.n).toBe(4);
    const sent = subs(sub(sub(readFields(t.calls[0]!.body), 8)!, 204)!, 1)[0]!;
    expect(BigInt(num(sent, 2))).toBe(NOW_US - 1_000_000n - 90_000_000n);
  });

  it('flags an unsent message from the placeholder TikTok leaves in the history, and only that one', async () => {
    standard();
    await engine.initialImport(() => undefined);
    t.handlers[HISTORY_PATH] = () =>
      historyBody([
        row({ id: '7700000000000000002', tsUs: NOW_US - 5_000_000n, sender: ME, text: 'second', cursor: NOW_US - 5_000_000n }),
        row({ id: '7700000000000000001', tsUs: NOW_US - 60_000_000n, sender: PEER, text: '', tags: [['s:is_recalled', '1']], cursor: NOW_US - 60_000_000n }),
      ]);
    await engine.readHistory(CONV, 50, 'history', ME);
    expect(ctx.repo.getMessage('7700000000000000001')).toMatchObject({ deleted_by: 'sender' });
    expect(ctx.repo.getMessage('7700000000000000002')!.deleted_at).toBeNull();
    expect(engine.unsent).toBe(1);
  });

  it('stores live socket frames: a message, a reaction on it, then its recall', async () => {
    standard();
    await engine.initialImport(() => undefined);
    const frame = (cmd: PbWriter) => new PbWriter().u64(1, 1).bytes(8, cmd.build()).build();
    const chat = (detail: PbWriter) => new PbWriter().u64(1, 500).message(6, new PbWriter().message(500, new PbWriter().string(2, CONV).message(5, detail)));
    expect(engine.handleFrame(frame(chat(row({ id: '7700000000000000020', tsUs: NOW_US, sender: PEER, text: 'live!' }))))).toBe(true);
    expect(ctx.repo.getMessage('7700000000000000020')).toMatchObject({ chat_id: CONV, from_me: 0 });
    const prop = `{"UserId":${PEER},"ServerMessageId":7700000000000000020,"Modifys":[{"Op":0,"Key":"e:❤️"},{"Op":0,"Key":"e:love"}]}`;
    engine.handleFrame(frame(chat(row({ id: '7700000000000000021', tsUs: NOW_US, sender: PEER, tags: [['s:property_modify', prop]] }))));
    expect(ctx.repo.reactionsFor(['7700000000000000020'])).toHaveLength(1);
    engine.handleFrame(frame(chat(row({ id: '7700000000000000022', tsUs: NOW_US, sender: PEER, tags: [['s:recall_uid', PEER], ['s:server_message_id', '7700000000000000020']] }))));
    expect(ctx.repo.getMessage('7700000000000000020')).toMatchObject({ deleted_by: 'sender' });
    expect(engine.handleFrame(Buffer.from([0xff, 0xff]))).toBe(false);
  });

  it('adopts a message the page-reading fallback stored earlier instead of duplicating it', async () => {
    standard();
    // The old path stored "second" with a synthetic id and the page's rough time.
    ingest.thread({ id: CONV, kind: 'user', peerId: PEER });
    const old = ingest.message({ id: 'srv:old', threadId: CONV, senderId: ME, fromMe: true, ts: Date.now() - 4_000, type: 'text', text: 'second', source: 'dom' }, 'dom')!;
    await engine.initialImport(() => undefined);
    const rows = ctx.repo.db.prepare("SELECT id, alt_id FROM messages WHERE chat_id = ? AND from_me = 1").all(CONV) as { id: string; alt_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id === old || rows[0]!.alt_id === '7700000000000000002' || rows[0]!.id === '7700000000000000002').toBe(true);
  });

  it('adopts page-read rows that are minutes off, clears a false "missing", and keeps different texts apart', async () => {
    standard();
    ingest.thread({ id: CONV, kind: 'user', peerId: PEER });
    const t0 = Date.now();
    const a = ingest.message({ id: 'srv:a', threadId: CONV, senderId: PEER, fromMe: false, ts: t0 - 4 * 60_000, type: 'text', text: 'first', source: 'dom' }, 'dom')!;
    ingest.message({ id: 'srv:b', threadId: CONV, senderId: ME, fromMe: true, ts: t0 - 3 * 60_000, type: 'text', text: 'another one', source: 'dom' }, 'dom');
    ctx.repo.updateMessage(a, { deleted_at: t0, deleted_by: 'missing' });
    await engine.initialImport(() => undefined);
    const rows = ctx.repo.db.prepare('SELECT id, alt_id, deleted_at FROM messages WHERE chat_id = ? ORDER BY ts').all(CONV) as { id: string; alt_id: string | null; deleted_at: number | null }[];
    // "first" (adopted, no longer missing), "second" (new), and the unrelated "another one" stays its own row.
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === a)).toMatchObject({ alt_id: '7700000000000000001', deleted_at: null });
  });

  it('hides empty chats TikTok does not list, but never a chat that has messages', async () => {
    standard();
    ingest.thread({ id: '7698000000000000123', kind: 'user' });
    ingest.thread({ id: '7698000000000000124', kind: 'user' });
    ingest.message({ id: 'srv:keep', threadId: '7698000000000000124', senderId: PEER, fromMe: false, ts: Date.now() - 1000, type: 'text', text: 'x', source: 'dom' }, 'dom');
    await engine.initialImport(() => undefined);
    expect(ctx.repo.getChat('7698000000000000123')!.removed_at).not.toBeNull();
    expect(ctx.repo.getChat('7698000000000000124')!.removed_at).toBeNull();
    expect(ctx.repo.getChat(CONV)!.removed_at).toBeNull();
  });

  it('names group senders and downloads profile pictures for chats', async () => {
    standard();
    await engine.initialImport(() => undefined);
    await engine.refreshPeople();
    const contact = ctx.repo.getContact(PEER)!;
    expect(contact.name_enc).not.toBeNull();
    expect(contact.avatar_media_id).not.toBeNull();
    expect(ctx.repo.getChat(CONV)!.avatar_media_id).not.toBeNull();
    expect(ctx.repo.getChat('987654321')!.avatar_media_id).toBeNull(); // no group picture known
    // a stranger speaking in a group is named without waiting for the periodic pass
    t.profiles['7000000000000000099'] = { nick: 'Zeynep', unique: 'zeynep' };
    const frame = new PbWriter().u64(1, 1).bytes(8, new PbWriter().u64(1, 500).message(6, new PbWriter().message(500, new PbWriter().string(2, '987654321').message(5, row({ conv: '987654321', id: '7700000000000000050', tsUs: NOW_US, sender: '7000000000000000099', text: 'selam' })))).build()).build();
    engine.handleFrame(frame);
    await new Promise((res) => setTimeout(res, 2600));
    expect(ctx.repo.getContact('7000000000000000099')!.name_enc).not.toBeNull();
  });

  describe('sending', () => {
    const sendOk = (id: string) => new PbWriter().u64(1, 100).u64(3, 0).message(6, new PbWriter().message(100, new PbWriter().u64(1, BigInt(id)))).build();

    it('sends with a DPoP proof and ticket-guard headers, and stores the message under TikTok’s id', async () => {
      standard();
      await engine.initialImport(() => undefined);
      t.handlers[SEND_PATH] = () => sendOk('7700000000000000030');
      const id = await engine.sendText(CONV, 'merhaba');
      expect(id).toBe('7700000000000000030');
      expect(ctx.repo.getMessage('7700000000000000030')).toMatchObject({ chat_id: CONV, from_me: 1, source: 'sent' });
      const call = t.calls.find((c) => c.path === SEND_PATH)!;
      expect(call.query['ztca-dpop']).toMatch(/^eyJ/);
      expect(call.query.msToken).toBe('tok');
      expect(call.headers['tt-ticket-guard-public-key']).toMatch(/^[A-Za-z0-9+/=]{80,}$/);
      const body = sub(sub(readFields(call.body), 8)!, 100)!;
      expect(str(body, 1)).toBe(CONV);
      expect(num(body, 3)).toBe(SRC);
      expect(JSON.parse(str(body, 4))).toEqual({ aweType: 0, text: 'merhaba' });
    });

    it('reports a refusal as "not sent" and a lost answer as "maybe sent"', async () => {
      standard();
      await engine.initialImport(() => undefined);
      t.handlers[SEND_PATH] = () => ({ status: 403, body: Buffer.alloc(0) });
      await expect(engine.sendText(CONV, 'x')).rejects.toMatchObject({ maybeSent: false });
      t.handlers[SEND_PATH] = () => new PbWriter().u64(1, 100).u64(3, 12345).build();
      await expect(engine.sendText(CONV, 'x')).rejects.toBeInstanceOf(ImSendError);
      t.handlers[SEND_PATH] = () => new Error('Failed to fetch');
      await expect(engine.sendText(CONV, 'x')).rejects.toMatchObject({ maybeSent: true });
      expect(ctx.repo.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE source = 'sent'").get()).toEqual({ n: 0 });
    });

    it('does not guess for a conversation TikTok never listed', async () => {
      standard();
      await engine.initialImport(() => undefined);
      t.handlers[COMBO_PATH] = () => comboBody([], NOW_US);
      await expect(engine.sendText('0:1:1:2', 'x')).rejects.toMatchObject({ maybeSent: false });
    });
  });
});
