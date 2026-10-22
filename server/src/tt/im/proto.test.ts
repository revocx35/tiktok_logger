import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ticketGuard, toTtMessage } from './engine.js';
import {
  buildComboRequest,
  buildHistoryRequest,
  buildInboxRequest,
  buildReactionRequest,
  buildSendRequest,
  buildUnreactionRequest,
  replyReferenceJson,
  sendContent,
  parseCombo,
  parseContent,
  parseHistory,
  parseInbox,
  parseSend,
  parseSocketFrame,
  type ImEnv,
} from './proto.js';
import { lz4Block, num, PbWriter, readFields, str, sub, subs } from './wire.js';

const env: ImEnv = {
  deviceId: '7000000000000000001',
  msToken: 'tok',
  verifyFp: '',
  userAgent: 'UA/1.0',
  language: 'en-US',
  platform: 'Linux x86_64',
  tz: 'UTC',
  region: 'TR',
  screenW: 1280,
  screenH: 800,
  historyLen: 2,
};
const ME = '7000000000000000001';
const PEER = '7000000000000000042';
const CONV = `0:1:${ME}:${PEER}`;

/** A message row as TikTok sends it (history row, combo row and socket detail share these field numbers). */
function row(opts: { conv?: string; id: string; tsUs: string; sender: string; content?: object | null; tags?: [string, string][]; source?: string; cursor?: string; subtype?: string }): PbWriter {
  const w = new PbWriter().string(1, opts.conv ?? CONV).u64(3, BigInt(opts.id)).u64(4, BigInt(opts.tsUs));
  if (opts.source) w.u64(5, BigInt(opts.source));
  w.u64(7, BigInt(opts.sender));
  if (opts.content !== null) w.bytes(8, Buffer.from(JSON.stringify(opts.content ?? { aweType: 700, text: 'hi' })));
  for (const [k, v] of opts.tags ?? [['s:client_message_id', 'abc']]) w.message(9, new PbWriter().string(1, k).bytes(2, Buffer.from(v)));
  if (opts.subtype) w.string(21, opts.subtype);
  if (opts.cursor) w.u64(25, BigInt(opts.cursor));
  return w;
}

describe('wire', () => {
  it('round-trips fields, including 64-bit ids', () => {
    const buf = new PbWriter().u64(1, 7646000000000000817n).string(2, 'héllo').message(3, new PbWriter().u64(1, 0)).build();
    const fs = readFields(buf);
    expect(num(fs, 1)).toBe('7646000000000000817');
    expect(str(fs, 2)).toBe('héllo');
    expect(num(sub(fs, 3)!, 1)).toBe('0');
  });

  it('refuses truncated and nonsense input instead of reading past it', () => {
    expect(() => readFields(Buffer.from([0x0a, 0x05, 0x61]))).toThrow();
    expect(() => readFields(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toThrow();
    expect(() => readFields(Buffer.from([0x00]))).toThrow();
  });

  it('decodes LZ4 blocks with literals, matches and overlapping copies', () => {
    expect(lz4Block(Buffer.from([0x50, 0x68, 0x65, 0x6c, 0x6c, 0x6f])).toString()).toBe('hello');
    // "abc" then a 6-byte match at distance 3 → "abcabcabc"
    expect(lz4Block(Buffer.from([0x32, 0x61, 0x62, 0x63, 0x03, 0x00])).toString()).toBe('abcabcabc');
    // an overlapping match: "a" then 7 bytes copied from distance 1 → "aaaaaaaa"
    expect(lz4Block(Buffer.from([0x13, 0x61, 0x01, 0x00])).toString()).toBe('aaaaaaaa');
    expect(() => lz4Block(Buffer.from([0x13, 0x61, 0x09, 0x00]))).toThrow();
    expect(() => lz4Block(Buffer.from([0xf0, 0xff]))).toThrow();
  });
});

describe('requests', () => {
  it('writes the envelope the web client sends (type, sub-command, payload, metadata, trailing flag)', () => {
    const top = readFields(buildInboxRequest(env, 10006));
    expect(num(top, 1)).toBe('203');
    expect(num(top, 2)).toBe('10006');
    expect(str(top, 3)).toBe('1.6.0');
    expect(str(top, 9)).toBe(env.deviceId);
    expect(str(top, 11)).toBe('web');
    expect(num(top, 18)).toBe('1');
    const meta = Object.fromEntries(subs(top, 15).map((m) => [str(m, 1), str(m, 2)]));
    expect(meta).toMatchObject({ aid: '1988', device_id: env.deviceId, region: 'TR', 'Web-Sdk-Ms-Token': 'tok', user_agent: 'UA/1.0', tz_name: 'UTC' });
    expect(num(sub(sub(top, 8)!, 203)!, 1)).toBe('0');
  });

  it('asks for a conversation page with its short id and a cursor', () => {
    const top = readFields(buildHistoryRequest(env, CONV, '7646000000000000817', '1792652983149460', 50));
    expect(num(top, 1)).toBe('301');
    expect(top.find((f) => f.n === 9)).toBeUndefined();
    const q = sub(sub(top, 8)!, 301)!;
    expect(str(q, 1)).toBe(CONV);
    expect(num(q, 3)).toBe('7646000000000000817');
    expect(num(q, 5)).toBe('1792652983149460');
    expect(num(q, 6)).toBe('50');
  });

  it('asks the all-conversations feed for two lanes from cursors', () => {
    const top = readFields(buildComboRequest(env, ['111', '222'], 50));
    expect(num(top, 1)).toBe('204');
    expect(num(top, 2)).toBe('10074');
    const lanes = subs(sub(top, 8)!.length ? sub(sub(top, 8)!, 204)! : [], 1);
    expect(lanes.map((l) => [num(l, 1), num(l, 2), num(l, 3)])).toEqual([['0', '111', '50'], ['1', '222', '50']]);
  });

  it('builds a text send with the content JSON, client message id and ticket-guard metadata', () => {
    const keys = ticketGuard();
    const top = readFields(buildSendRequest(env, { convId: CONV, sourceId: '7646000000000000817', isGroup: false, text: 'merhaba', clientMessageId: 'cid-1', publicKeyB64: keys.publicKeyB64 }));
    expect(num(top, 1)).toBe('100');
    expect(num(top, 2)).toBe('10009');
    const body = sub(sub(top, 8)!, 100)!;
    expect(str(body, 1)).toBe(CONV);
    expect(num(body, 2)).toBe('1');
    expect(num(body, 3)).toBe('7646000000000000817');
    expect(JSON.parse(str(body, 4))).toEqual({ aweType: 0, text: 'merhaba' });
    expect(str(body, 8)).toBe('cid-1');
    expect(subs(body, 5).map((t) => str(t, 1))).toEqual(['s:mentioned_users', 's:client_message_id']);
    const meta = subs(top, 15).map((m) => str(m, 1));
    expect(meta.indexOf('tt-ticket-guard-public-key')).toBeGreaterThan(-1);
    expect(meta.indexOf('tt-ticket-guard-web-version')).toBeLessThan(meta.indexOf('browser_version'));
    const group = readFields(buildSendRequest(env, { convId: '123', sourceId: '9', isGroup: true, text: 'x', clientMessageId: 'c', publicKeyB64: keys.publicKeyB64 }));
    expect(num(group, 2)).toBe('10014');
    expect(num(sub(sub(group, 8)!, 100)!, 2)).toBe('2');
  });

  it('signs a DPoP proof that verifies against the public key it announces', () => {
    const keys = ticketGuard();
    const jwt = keys.dpop('POST', 'https://im-api-sg.tiktok.com/v1/message/send');
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'ES256', typ: 'dpop+jwt' });
    expect(payload).toMatchObject({ htm: 'POST', htu: 'https://im-api-sg.tiktok.com/v1/message/send' });
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(5);
    const pub = createPublicKey({ key: header.jwk, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
    const point = Buffer.from(keys.publicKeyB64, 'base64');
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    expect(keys.dpop('POST', 'x')).not.toBe(keys.dpop('POST', 'x'));
  });
});

describe('answers', () => {
  it('reads the conversation list: ids, short ids, members, titles, and whether there is more', () => {
    const detail = new PbWriter()
      .string(1, '987654321')
      .u64(2, 5555)
      .u64(3, 2)
      .message(6, new PbWriter().message(1, new PbWriter().u64(1, BigInt(ME))).message(1, new PbWriter().u64(1, BigInt(PEER))))
      .message(50, new PbWriter().string(5, 'Study group').string(7, 'https://p.example/a.jpg'))
      .message(51, new PbWriter().u64(5, 1792678674216074n));
    const entry = new PbWriter().string(1, CONV).u64(2, 1).u64(3, 99).u64(4, 1792678674216074n).u64(5, 4444);
    const list = new PbWriter().message(1, entry).message(2, detail).u64(3, 1792678872678867n).u64(5, 1);
    const body = new PbWriter().u64(1, 203).u64(3, 0).message(6, new PbWriter().message(203, list)).build();
    const inbox = parseInbox(body);
    expect(inbox.hasMore).toBe(true);
    expect(inbox.nextCursor).toBe('1792678872678867');
    const g = inbox.conversations.find((c) => c.id === '987654321')!;
    expect(g).toMatchObject({ sourceId: '5555', type: 2, title: 'Study group', members: [ME, PEER], lastTsUs: '1792678674216074' });
    expect(inbox.conversations.find((c) => c.id === CONV)).toMatchObject({ sourceId: '4444', type: 1 });
  });

  it('reads history oldest-first, skips unsent placeholders but reports their ids, and returns the next cursor', () => {
    const rows = [
      row({ id: '300', tsUs: '1792000000300000', sender: PEER, cursor: '1792000000300999', content: { aweType: 700, text: 'newest' } }),
      row({ id: '200', tsUs: '1792000000200000', sender: ME, cursor: '1792000000200999', content: { aweType: 0, text: 'mine' } }),
      row({ id: '150', tsUs: '1792000000150000', sender: PEER, cursor: '1792000000150999', content: { hack: '1' }, tags: [['s:is_recalled', '1']] }),
      row({ id: '100', tsUs: '1792000000100000', sender: PEER, cursor: '1792000000100999' }),
    ];
    const list = new PbWriter();
    for (const r of rows) list.message(1, r);
    const body = new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, list)).build();
    const h = parseHistory(body);
    expect(h.messages.map((m) => m.serverId)).toEqual(['100', '200', '300']);
    expect(h.recalledIds).toEqual(['150']);
    expect(h.skipped).toBe(1);
    expect(h.nextCursorUs).toBe('1792000000100999');
    expect(h.messages[1]!.clientMessageId).toBe('abc');
  });

  it('reads the all-conversations feed per lane with its continuation cursor', () => {
    const lane = (kind: number, rows: PbWriter[], more: boolean, next: string) => {
      const l = new PbWriter().u64(1, kind);
      for (const r of rows) l.message(2, r);
      return l.u64(4, more ? 1 : 0).u64(5, BigInt(next));
    };
    const a = row({ id: '11', tsUs: '1792000000000011', sender: PEER, source: '4444', cursor: '1792000000000111' });
    const b = row({ conv: '987654321', id: '12', tsUs: '1792000000000012', sender: PEER, source: '5555', tags: [['s:is_recalled', '1']] });
    const body = new PbWriter().u64(1, 204).message(6, new PbWriter().message(204, new PbWriter().message(1, lane(0, [a], true, '1792000000000111')).message(1, lane(1, [b], false, '1792000000000222')))).build();
    const lanes = parseCombo(body);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toMatchObject({ kind: 0, hasMore: true, next: '1792000000000111' });
    expect(lanes[0]!.messages[0]).toMatchObject({ serverId: '11', convId: CONV, sourceId: '4444' });
    expect(lanes[1]).toMatchObject({ kind: 1, hasMore: false, recalledIds: ['12'], messages: [] });
  });

  it('reads the id of a sent message from either place TikTok puts it', () => {
    const a = new PbWriter().u64(1, 100).u64(3, 0).message(6, new PbWriter().message(100, new PbWriter().u64(1, 7700000000000000009n))).build();
    expect(parseSend(a)).toEqual({ status: '0', messageId: '7700000000000000009' });
    const b = new PbWriter().u64(1, 100).message(8, new PbWriter().message(100, new PbWriter().string(1, '7700000000000000010'))).build();
    expect(parseSend(b).messageId).toBe('7700000000000000010');
    expect(parseSend(new PbWriter().u64(1, 100).u64(3, 12345).build())).toEqual({ status: '12345', messageId: '' });
    // the request type echoed in field 1 is not a status
    expect(parseSend(new PbWriter().u64(1, 100).build()).status).toBe('');
  });
});

describe('content', () => {
  const msgOf = (content: object | null, extra: Partial<Parameters<typeof parseContent>[0]> = {}) =>
    parseContent({ content: content ? Buffer.from(JSON.stringify(content)) : Buffer.alloc(0), media: null, subtype: '', ...extra });

  it('maps text, replies, shared videos and unknown types', () => {
    expect(msgOf({ aweType: 700, text: 'a' })).toMatchObject({ type: 'text', text: 'a' });
    expect(msgOf({ aweType: 0, text: 'b' })).toMatchObject({ type: 'text', text: 'b' });
    expect(msgOf({ aweType: 703, text: 'r' })).toMatchObject({ type: 'text', text: 'r' });
    expect(msgOf({ aweType: 800, itemId: '7412345678901234567', content_title: 'a video', uid: '1' })).toMatchObject({ type: 'shared_post', text: 'a video', meta: { itemId: '7412345678901234567' } });
    expect(msgOf({ aweType: 1234, text: 'x' })).toMatchObject({ type: 'unsupported', meta: { aweType: 1234 } });
    expect(msgOf({ hack: '1' })).toMatchObject({ type: 'unsupported', text: null });
    expect(msgOf(null)).toMatchObject({ type: 'unsupported' });
  });

  it('turns a history row into a stored-message record (ids as strings, microseconds to ms, own side)', () => {
    const rows = [row({ id: '7700000000000000200', tsUs: '1792000000200000', sender: ME, content: { aweType: 0, text: 'mine' } })];
    const list = new PbWriter();
    for (const r of rows) list.message(1, r);
    const h = parseHistory(new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, list)).build());
    const m = toTtMessage(h.messages[0]!, ME)!;
    expect(m).toMatchObject({ id: '7700000000000000200', threadId: CONV, senderId: ME, fromMe: true, ts: 1792000000200, type: 'text', text: 'mine' });
    expect(toTtMessage(h.messages[0]!, PEER)!.fromMe).toBe(false);
  });
});

describe('socket frames', () => {
  const frame = (inner: Buffer, lz4 = false): Buffer => {
    const payload = lz4 ? Buffer.concat([Buffer.from([Math.min(inner.length, 14) << 4 | 0]), inner]) : inner;
    const w = new PbWriter().u64(1, 1).u64(2, 2);
    if (lz4) w.bytes(6, Buffer.from('__lz4'));
    return w.bytes(8, payload).build();
  };
  const chat = (detail: PbWriter, conv = CONV) => new PbWriter().u64(1, 500).message(6, new PbWriter().message(500, new PbWriter().string(2, conv).message(5, detail))).build();

  it('decodes a chat message, plain', () => {
    const ev = parseSocketFrame(frame(chat(row({ id: '500', tsUs: '1792000000500000', sender: PEER, content: { aweType: 700, text: 'yo' } }))));
    expect(ev).toMatchObject({ kind: 'message', message: { serverId: '500', senderId: PEER, convId: CONV } });
  });

  it('decodes a chat message inside an LZ4 block', () => {
    // A literal-only block (token = length << 4) is a valid LZ4 block; it keeps the test free of a compressor.
    const inner = chat(row({ id: '501', tsUs: '1792000000501000', sender: PEER }));
    const lits = inner.length;
    const token = lits < 15 ? Buffer.from([lits << 4]) : Buffer.concat([Buffer.from([0xf0]), Buffer.from(Array(Math.floor((lits - 15) / 255)).fill(255)), Buffer.from([(lits - 15) % 255])]);
    const outer = new PbWriter().u64(1, 1).bytes(6, Buffer.from('__lz4')).bytes(8, Buffer.concat([token, inner])).build();
    expect(parseSocketFrame(outer)).toMatchObject({ kind: 'message', message: { serverId: '501' } });
  });

  it('decodes a recall (delete for everyone) as the id of the message that was unsent', () => {
    const detail = row({ id: '600', tsUs: '1792000000600000', sender: PEER, content: null, tags: [['s:recall_uid', PEER], ['s:server_message_id', '7700000000000000500']] });
    expect(parseSocketFrame(frame(chat(detail)))).toEqual({ kind: 'recall', convId: CONV, serverId: '7700000000000000500', byUserId: PEER });
  });

  it('decodes a reaction, preferring the emoji over its text alias', () => {
    const prop = `{"UserId":${PEER},"ServerMessageId":7700000000000000500,"Modifys":[{"Op":0,"Key":"e:love"},{"Op":0,"Key":"e:❤️"}]}`;
    const detail = row({ id: '601', tsUs: '1792000000601000', sender: PEER, content: null, tags: [['s:property_modify', prop]] });
    expect(parseSocketFrame(frame(chat(detail)))).toMatchObject({ kind: 'reaction', serverId: '7700000000000000500', userId: PEER, emoji: '❤️', removed: false });
  });

  it('decodes read receipts and typing, and ignores heartbeats and garbage', () => {
    const receipt = new PbWriter().u64(1, 501).message(6, new PbWriter().message(501, new PbWriter().string(1, CONV).u64(3, 1792000000700000n).u64(5, BigInt(PEER)).u64(6, 500n))).build();
    expect(parseSocketFrame(frame(receipt))).toMatchObject({ kind: 'receipt', convId: CONV, readServerId: '500' });
    const typing = new PbWriter().u64(1, 510).message(6, new PbWriter().message(510, new PbWriter().u64(1, BigInt(PEER)).string(2, CONV))).build();
    expect(parseSocketFrame(frame(typing))).toEqual({ kind: 'typing', convId: CONV, userId: PEER });
    expect(parseSocketFrame(new PbWriter().u64(1, 1).build())).toBeNull();
    expect(parseSocketFrame(frame(new PbWriter().u64(1, 0).build()))).toBeNull();
    expect(() => parseSocketFrame(Buffer.from([0xff, 0xff]))).toThrow();
  });

  it('skips an unsent placeholder pushed as a chat frame', () => {
    const detail = row({ id: '602', tsUs: '1792000000602000', sender: PEER, tags: [['s:is_recalled', '1']] });
    expect(parseSocketFrame(frame(chat(detail)))).toBeNull();
  });
});

describe('media rows', () => {
  it('finds the full photo, its thumbnail and the key; and the play/cover URLs of a video', () => {
    const variant = (label: string, url: string, w: number) => new PbWriter().bytes(1, Buffer.from(label)).string(2, url).u64(20, w).u64(21, w);
    const image = new PbWriter().string(3, 'ab'.repeat(32)).message(20, variant('view', 'https://p16.ibyteimg.com/x~thumb.image', 100)).message(20, variant('full', 'https://p16.ibyteimg.com/x~default.image', 1000));
    const r = row({ id: '700', tsUs: '1792000000700000', sender: PEER, content: { hack: '1' }, subtype: 'private_image' }).message(24, image);
    const list = new PbWriter().message(1, r);
    const h = parseHistory(new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, list)).build());
    const m = h.messages[0]!;
    expect(m.media).toMatchObject({ kind: 'image', url: 'https://p16.ibyteimg.com/x~default.image', thumbUrl: 'https://p16.ibyteimg.com/x~thumb.image', decryptKey: 'ab'.repeat(32), width: 1000 });
    expect(toTtMessage(m, ME)).toMatchObject({ type: 'media', media: [{ kind: 'image', decryptKey: 'ab'.repeat(32) }] });

    const video = new PbWriter()
      .message(20, new PbWriter().bytes(1, Buffer.from('play')).string(2, 'https://v.example/x?mime_type=video_mp4').u64(20, 720).u64(21, 1280).u64(22, 4200))
      .message(20, new PbWriter().bytes(1, Buffer.from('cover')).string(2, 'https://v.example/x~tplv-noop.image'));
    const rv = row({ id: '701', tsUs: '1792000000701000', sender: PEER, content: { hack: '1' }, subtype: 'private_video' }).message(24, video);
    const hv = parseHistory(new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, new PbWriter().message(1, rv))).build());
    expect(hv.messages[0]!.media).toMatchObject({ kind: 'video', url: 'https://v.example/x?mime_type=video_mp4', thumbUrl: 'https://v.example/x~tplv-noop.image', durationMs: 4200 });
  });

  it('reads a sticker and gives it a label', () => {
    const sticker = new PbWriter()
      .message(1, new PbWriter().string(2, 'https://p.example/s.webp').message(5, new PbWriter().u64(1, 200).u64(2, 200)))
      .message(2, new PbWriter().message(3, new PbWriter().string(1, '[sticker]')));
    const r = row({ id: '702', tsUs: '1792000000702000', sender: PEER, content: { hack: '1' } }).message(20, new PbWriter().message(7, sticker));
    const h = parseHistory(new PbWriter().u64(1, 0).message(6, new PbWriter().message(301, new PbWriter().message(1, r))).build());
    expect(h.messages[0]!.media).toMatchObject({ kind: 'sticker', url: 'https://p.example/s.webp', width: 200 });
    expect(toTtMessage(h.messages[0]!, ME)).toMatchObject({ type: 'sticker' });
  });
});

describe('reactions (set_property, 705/10008)', () => {
  const args = {
    convId: CONV,
    sourceId: PEER,
    messageId: '7412345678901234567',
    emoji: '❤️',
    selfUserId: ME,
    isGroup: false,
    clientMessageId: '11111111-2222-3333-4444-555555555555',
    publicKeyB64: 'pk',
  };

  it('builds an add-reaction envelope TikTok can read', () => {
    const fields = readFields(buildReactionRequest(env, args));
    expect(num(fields, 1)).toBe('705');
    expect(num(fields, 2)).toBe('10008');
    const wrapper = sub(sub(fields, 8)!, 705)!;
    expect(str(wrapper, 2)).toBe('deprecated');
    const body = sub(wrapper, 1)!;
    expect(str(body, 1)).toBe(CONV);
    expect(num(body, 2)).toBe('1');
    expect(num(body, 3)).toBe(PEER);
    expect(num(body, 4)).toBe('7412345678901234567');
    expect(str(body, 5)).toBe(args.clientMessageId);
    const mutation = sub(body, 6)!;
    expect(num(mutation, 1)).toBe('0'); // 0 = add
    expect(str(mutation, 2)).toBe('e:❤️');
    expect(str(mutation, 4)).toBe(ME);
    // The ticket guard travels with the request, like a send.
    const meta = subs(fields, 15).map((kv) => str(kv, 1));
    expect(meta).toContain('tt-ticket-guard-public-key');
  });

  it('uses action_flag 2 in a group (1 in a direct chat), as TikTok\'s own client does', () => {
    const group = sub(sub(sub(readFields(buildReactionRequest(env, { ...args, isGroup: true })), 8)!, 705)!, 1)!;
    expect(num(group, 2)).toBe('2');
    const dm = sub(sub(sub(readFields(buildReactionRequest(env, args)), 8)!, 705)!, 1)!;
    expect(num(dm, 2)).toBe('1');
  });

  it('builds a remove-reaction envelope with action 1', () => {
    const body = sub(sub(sub(readFields(buildUnreactionRequest(env, args)), 8)!, 705)!, 1)!;
    expect(num(sub(body, 6)!, 1)).toBe('1'); // 1 = remove
  });
});

describe('send content: replies and shared posts', () => {
  it('sends plain text as aweType 0', () => {
    expect(JSON.parse(sendContent({ text: 'hi', reply: null, share: null }))).toEqual({ aweType: 0, text: 'hi' });
  });

  it('sends a reply as aweType 703 and attaches the reference at field 11', () => {
    const body = buildSendRequest(env, {
      convId: CONV,
      sourceId: PEER,
      isGroup: false,
      text: 'answering',
      clientMessageId: 'c-1',
      publicKeyB64: 'pk',
      reply: { messageId: '7412345678901234567', contentJson: '{"aweType":0,"text":"quoted"}', uid: PEER, secUid: 'MS4w', cursorUs: '1792000000300000' },
    });
    const send = sub(sub(readFields(body), 8)!, 100)!;
    expect(JSON.parse(str(send, 4))).toEqual({ aweType: 703, text: 'answering' });
    const ref = sub(send, 11)!;
    expect(num(ref, 1)).toBe('7412345678901234567');
    const json = JSON.parse(Buffer.from(str(ref, 2) ?? '', 'utf8').toString());
    expect(json).toMatchObject({ refmsg_uid: PEER, refmsg_sec_uid: 'MS4w', refmsg_type: 7 });
    expect(json.content).toBe('{"aweType":0,"text":"quoted"}');
    expect(num(ref, 4)).toBe('1792000000300000');
  });

  it('sends a shared post as an aweType 800 card with the item and its author', () => {
    const body = buildSendRequest(env, {
      convId: CONV,
      sourceId: PEER,
      isGroup: false,
      text: '',
      clientMessageId: 'c-2',
      publicKeyB64: 'pk',
      share: { itemId: '7412345678901234567', uid: '7412345678900000001', secUid: 'MS4wLj', title: 'a video', cover: 'https://p16.example.com/c.jpg' },
    });
    const send = sub(sub(readFields(body), 8)!, 100)!;
    expect(JSON.parse(str(send, 4))).toEqual({
      aweType: 800,
      itemId: '7412345678901234567',
      uid: '7412345678900000001',
      sec_uid: 'MS4wLj',
      content_title: 'a video',
      cover_url: 'https://p16.example.com/c.jpg',
    });
  });

  it('keeps the quoted content when a reply has no text to quote', () => {
    const json = JSON.parse(replyReferenceJson('', PEER, 'sec'));
    expect(json.content).toBe('{"aweType":0,"text":""}');
  });
});
