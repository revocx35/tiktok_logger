/**
 * Read-only probe of TikTok's IM protocol against a live logged-in tab. Prints structure only (counts, ids masked,
 * field shapes) — never message text. Bundle with esbuild and run next to the browser (see docs/tiktok-notes.md):
 *   node im-probe.mjs <devtools-port> [convIndex]
 */
import WebSocket from 'ws';
import { readFields, type Field } from '../../server/src/tt/im/wire.js';
import { ImTransport, randomBogus, type PageLike } from '../../server/src/tt/im/transport.js';
import { buildComboRequest, COMBO_PATH, buildHistoryRequest, buildInboxRequest, HISTORY_PATH, INBOX_PATH, parseContent, parseHistory, parseInbox } from '../../server/src/tt/im/proto.js';

const port = process.argv[2] ?? '41719';
const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
const tab = list.find((t) => t.type === 'page' && t.url.includes('/messages'));
if (!tab) throw new Error('no messages tab');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let n = 0;
const pending = new Map<number, (d: any) => void>();
ws.on('message', (m) => {
  const d = JSON.parse(String(m));
  pending.get(d.id)?.(d);
});
const page: PageLike = {
  async evaluate(fn, ...args) {
    const id = ++n;
    const expr = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const res = await new Promise<any>((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
    return res.result.result.value;
  },
};
/** Structure only: field numbers, wire types, sizes, and the shape of repeated rows (depth-limited). */
function shape(b: Buffer, depth = 0, ind = ''): string[] {
  let fs: Field[];
  try { fs = readFields(b); } catch { return []; }
  const out: string[] = [];
  const counts = new Map<number, number>();
  for (const f of fs) counts.set(f.n, (counts.get(f.n) ?? 0) + 1);
  const shown = new Set<number>();
  for (const f of fs) {
    if (f.wt === 0) out.push(`${ind}${f.n}: varint ${String(f.v).length > 5 ? '#' + String(f.v).length : f.v}`);
    else if (f.wt === 2) {
      if (shown.has(f.n)) continue;
      shown.add(f.n);
      const cnt = counts.get(f.n)!;
      const txt = f.b!.toString('utf8');
      const nested = depth < 5 ? shape(f.b!, depth + 1, ind + '  ') : [];
      if (/^[\x20-\x7e]+$/.test(txt) && !nested.length) out.push(`${ind}${f.n}${cnt > 1 ? ' x' + cnt : ''}: str(${f.b!.length}) ${/^\d{5,}$/.test(txt) ? '#' + txt.length : txt.length < 24 ? JSON.stringify(txt.replace(/\d{6,}/g, '#')) : ''}`);
      else if (nested.length) { out.push(`${ind}${f.n}${cnt > 1 ? ' x' + cnt : ''}: msg(${f.b!.length})`); out.push(...nested); }
      else out.push(`${ind}${f.n}${cnt > 1 ? ' x' + cnt : ''}: bytes(${f.b!.length})`);
    }
  }
  return out;
}
const mask = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-3)}` : s);
const t = new ImTransport(page);
const { env, uid } = await t.env();
console.log('env', { deviceId: mask(env.deviceId), uid: mask(uid), region: env.region, hasMsToken: !!env.msToken, hasVerifyFp: !!env.verifyFp, lang: env.language, tz: env.tz });

const variants: { name: string; query: () => Promise<Record<string, string>> }[] = [
  { name: 'bare', query: async () => ({}) },
  { name: 'base', query: async () => t.baseQuery() },
];
void randomBogus;
if (process.argv.includes('--combo')) {
  for (const hash of ['0120411:master', '']) {
    const r = await t.post(COMBO_PATH, buildComboRequest(env, ['0', '0'], 50, hash), { query: {} });
    console.log('combo hash', JSON.stringify(hash), 'http', r.status, 'bytes', r.body.length);
    if (hash === '0120411:master') {
      const top = readFields(r.body);
      const list = readFields(top.find((f) => f.n === 6)!.b!);
      const lanes = readFields(list.find((f) => f.n === 204)!.b!).filter((f) => f.n === 1);
      const all = new Set<string>();
      lanes.forEach((l, i) => {
        const lf = readFields(l.b!);
        const rows = lf.filter((f) => f.n === 2).map((f) => readFields(f.b!));
        const ids = new Set(rows.map((r2) => r2.find((x) => x.n === 1)?.b?.toString('utf8') ?? ''));
        ids.forEach((x) => all.add(x));
        const get = (n: number) => String(lf.find((f) => f.n === n)?.v ?? '');
        console.log('lane', i, 'kind', get(1), 'rows', rows.length, 'uniqueConvs', ids.size, 'hasMore(4)', get(4), 'next(5)', get(5).length, 'f6', get(6), 'groupsInLane', [...ids].filter((x) => !x.startsWith('0:1:')).length);
      });
      console.log('combo unique conversations', all.size);
    }
  }
}
if (process.argv.includes('--sem')) {
  const lane0 = async (cursor: string) => {
    const r = await t.post(COMBO_PATH, buildComboRequest(env, [cursor, '0'], 50), { query: {} });
    const list = readFields(readFields(r.body).find((f) => f.n === 6)!.b!);
    const l = readFields(readFields(list.find((f) => f.n === 204)!.b!).find((f) => f.n === 1)!.b!);
    const rows = l.filter((f) => f.n === 2).map((f) => readFields(f.b!));
    const ts = rows.map((x) => BigInt(String(x.find((y) => y.n === 27)?.v ?? 0))).filter((x) => x > 0n);
    const min = ts.reduce((a, b) => (a < b ? a : b), ts[0] ?? 0n), max = ts.reduce((a, b) => (a > b ? a : b), 0n);
    const next = String(l.find((f) => f.n === 5)?.v ?? '');
    const age = (x: bigint) => (x ? ((Date.now() * 1000 - Number(x)) / 86400e6).toFixed(1) + 'd' : '-');
    console.log('cursor', cursor === '0' ? '0' : age(BigInt(cursor)) + ' ago', '-> rows', rows.length, 'oldest', age(min), 'newest', age(max), 'hasMore', String(l.find((f) => f.n === 4)?.v ?? ''), 'next', next === '' ? '-' : age(BigInt(next)) + ' ago');
    return next;
  };
  let c = '0';
  for (let i = 0; i < 4; i++) c = await lane0(c);
  await lane0(String((Date.now() - 3 * 86400e3) * 1000));
  await lane0(String((Date.now() - 20 * 60e3) * 1000));
}
if (process.argv.includes('--match')) {
  var convs: ReturnType<typeof parseInbox>['conversations'] = (await (async () => { const a = parseInbox((await t.post(INBOX_PATH, buildInboxRequest(env, 10006), { query: {} })).body); const g = parseInbox((await t.post(INBOX_PATH, buildInboxRequest(env, 10002), { query: {} })).body); return [...a.conversations, ...g.conversations]; })());
  const since = String((Date.now() - 4 * 86400e3) * 1000);
  const r = await t.post(COMBO_PATH, buildComboRequest(env, [since, since], 50), { query: {} });
  const list = readFields(readFields(r.body).find((f) => f.n === 6)!.b!);
  const lanes = readFields(list.find((f) => f.n === 204)!.b!).filter((f) => f.n === 1).map((f) => readFields(f.b!));
  const rows = lanes.flatMap((l) => l.filter((f) => f.n === 2).map((f) => readFields(f.b!)));
  const v = (fs: Field[], n: number) => String(fs.find((x) => x.n === n)?.v ?? '');
  const sx = (fs: Field[], n: number) => fs.find((x) => x.n === n)?.b?.toString('utf8') ?? '';
  const byConv = new Map<string, Field[][]>();
  for (const row of rows) byConv.set(sx(row, 1), [...(byConv.get(sx(row, 1)) ?? []), row]);
  console.log('combo rows', rows.length, 'convs', byConv.size);
  for (const [conv, rs] of [...byConv].slice(0, 3)) {
    const inbox = convs.find((c) => c.id === conv);
    const src = v(rs[0]!, 5);
    const h = await t.post(HISTORY_PATH, buildHistoryRequest(env, conv, src, '0', 50), { query: {} });
    const hist = parseHistory(h.body).messages;
    const hid = new Map(hist.map((m) => [m.serverId, m]));
    let hit = 0, f3 = 0, tsEq = 0, srcEq = 0, f10 = 0, cur = 0, snd = 0, same = 0;
    for (const row of rs) {
      const m = hid.get(v(row, 3));
      if (m && hit === 0) console.log(' sample ts', { histTsUs: m.tsUs, histCursor: m.cursorUs, f10: v(row, 10), f11: v(row, 11), f13: v(row, 13), f27: v(row, 27), f4: v(row, 4), f6: v(row, 6) });
      if (m) { hit++; if (m.tsUs === v(row, 27)) tsEq++; if (m.tsUs.slice(0, 13) === v(row, 10)) f10++; if (m.cursorUs === v(row, 27)) cur++; if (m.senderId === v(row, 7)) snd++; if (m.content.equals(Buffer.from(row.find((x) => x.n === 8)?.b ?? []))) same++; }
      if (inbox && inbox.sourceId === v(row, 5)) srcEq++;
      if (hid.has(v(row, 7))) f3++;
    }
    console.log('conv', mask(conv), 'rows', rs.length, 'historyHit(by f3)', hit, 'ts==f27', tsEq, 'f5==inbox.sourceId', srcEq, '/', inbox ? 'inbox-known' : 'not-in-inbox', 'histStatus', h.status, 'histMsgs', hist.length, { f10eqTsMs: f10, f27eqCursor: cur, senderEq: snd, contentEq: same });
  }
}
const idsOf = (b: Buffer) => parseInbox(b).conversations.map((c) => c.id).sort().join(',');
{
  const base = await t.post(INBOX_PATH, buildInboxRequest(env, 10006), { query: {} });
  const bi = parseInbox(base.body);
  console.log('base ids', bi.conversations.length, 'next', bi.nextCursor);
  const tries: [string, Buffer][] = [
    ['limit50', buildInboxRequest(env, 10006, '0', { limit: 50 })],
    ['limit50+contype1', buildInboxRequest(env, 10006, '0', { limit: 50, conType: 1 })],
    ['cursor f2', buildInboxRequest(env, 10006, bi.nextCursor)],
    ['cursor f2 limit50', buildInboxRequest(env, 10006, bi.nextCursor, { limit: 50 })],
    ['cursor f3', buildInboxRequest(env, 10006, bi.nextCursor, { cursorField: 3 })],
  ];
  for (const [name, body] of tries) {
    const r = await t.post(INBOX_PATH, body, { query: {} });
    let line = `${name}: http ${r.status} bytes ${r.body.length}`;
    try { const i = parseInbox(r.body); line += ` convs ${i.conversations.length} hasMore ${i.hasMore} sameAsBase ${idsOf(r.body) === idsOf(base.body)} newIds ${i.conversations.filter((c) => !bi.conversations.some((x) => x.id === c.id)).length}`; } catch (e) { line += ' parse failed'; }
    console.log('try', line);
  }
}
convs = [];
for (const kind of [10006, 10002] as const) {
  let cursor = '0';
  for (let page = 1; page <= 12; page++) {
    const r = await t.post(INBOX_PATH, buildInboxRequest(env, kind, cursor), { query: {} });
    let inbox;
    try { inbox = parseInbox(r.body); } catch (e) { console.log('inbox parse failed', (e as Error).message); break; }
    console.log('inbox', kind, 'page', page, 'http', r.status, 'bytes', r.body.length, 'conversations', inbox.conversations.length, 'hasMore', inbox.hasMore, 'next', inbox.nextCursor.length);
    convs.push(...inbox.conversations.filter((c) => !convs.some((x) => x.id === c.id)));
    if (!inbox.hasMore || !inbox.nextCursor) break;
    cursor = inbox.nextCursor;
  }
}
console.log('total conversations', convs.length, 'groups', convs.filter((c) => c.type === 2).length);
console.log('conv sample', convs.slice(0, 3).map((c) => ({ id: mask(c.id), src: mask(c.sourceId), type: c.type, members: c.members.length, lastTsUs: c.lastTsUs.length })));
const c = convs[Number(process.argv[3] ?? 0)];
if (c) {
  for (const v of variants) {
    const r = await t.post(HISTORY_PATH, buildHistoryRequest(env, c.id, c.sourceId, '0', 20), { query: await v.query() }).catch((e: Error) => ({ status: -1, body: Buffer.from(e.message) }));
    let h;
    try { h = parseHistory(r.body); } catch { h = null; }
    console.log('history', v.name, 'http', r.status, 'bytes', r.body.length, h && { messages: h.messages.length, skipped: h.skipped, next: h.nextCursorUs });
    if (h && h.messages.length && v.name === 'base') {
      for (const m of h.messages.slice(-6)) {
        const k = parseContent(m);
        console.log(' msg', { id: mask(m.serverId), tsUs: m.tsUs.length, mine: m.senderId === uid, type: k.type, textLen: k.text?.length ?? 0, media: m.media?.kind ?? null, sub: m.subtype, tags: m.tags.map((x) => x.key) });
      }
    }
  }
}
process.exit(0);
