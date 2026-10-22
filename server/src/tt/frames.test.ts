import { describe, expect, it } from 'vitest';
import { extractJson, isImSocket, isImUrl, readBody, readFrame, walkProto } from './frames.js';

/* --------------------------------------------------------------- helpers */

/** Encodes one protobuf field (varint, length-delimited or a raw tag+bytes). */
function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function field(fieldNo: number, wire: number, payload: Buffer | number): Buffer {
  const tag = varint((fieldNo << 3) | wire);
  if (wire === 0) return Buffer.concat([tag, varint(payload as number)]);
  const body = payload as Buffer;
  return Buffer.concat([tag, varint(body.length), body]);
}

/* ----------------------------------------------------------------- proto */

describe('walkProto', () => {
  it('reads varints, strings and nested messages', () => {
    const nested = Buffer.concat([field(1, 0, 7), field(2, 2, Buffer.from('hi'))]);
    const buf = Buffer.concat([field(1, 0, 42), field(2, 2, nested), field(3, 2, Buffer.from('{"text":"yo"}'))]);
    const fields = walkProto(buf);
    expect(fields).toHaveLength(3);
    expect(fields[0]!.value).toBe(42n);
    expect(fields[1]!.children).toHaveLength(2);
    expect(fields[1]!.children![1]!.text).toBe('hi');
    expect(fields[2]!.text).toBe('{"text":"yo"}');
  });

  it('returns nothing (never throws) for random binary', () => {
    const junk = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37]);
    expect(() => walkProto(junk)).not.toThrow();
    expect(Array.isArray(walkProto(junk))).toBe(true);
  });

  it('ignores truncated fields instead of misreading them', () => {
    const full = field(2, 2, Buffer.from('{"a":1}'));
    expect(walkProto(full)).toHaveLength(1);
    expect(walkProto(full.subarray(0, full.length - 3))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ JSON */

describe('extractJson', () => {
  it('finds objects inside text and keeps braces in strings', () => {
    const text = 'prefix {"text":"a } b","n":1} suffix {"x":{"y":2}}';
    const found = extractJson(text);
    expect(found).toHaveLength(2);
    expect((found[0] as { text: string }).text).toBe('a } b');
    expect((found[1] as { x: { y: number } }).x.y).toBe(2);
  });

  it('stops at an unterminated object', () => {
    expect(extractJson('{"a":1} {"b":')).toHaveLength(1);
  });

  it('caps the number of objects', () => {
    const text = Array.from({ length: 500 }, () => '{"a":1}').join(' ');
    expect(extractJson(text, 10)).toHaveLength(10);
  });
});

/* ----------------------------------------------------------------- frames */

describe('readFrame', () => {
  it('recoveries a JSON text message out of a protobuf envelope (the Douyin/TikTok shape)', () => {
    // Field 8 is the message container; field 100 inside it is the content, a JSON string.
    const content = Buffer.from(JSON.stringify({ text: 'hello', aweType: 700, createdAt: 1700000000000 }));
    const inner = Buffer.concat([field(1, 2, Buffer.from('0:1:2:3')), field(4, 2, content)]);
    const frame = Buffer.concat([field(1, 0, 100), field(8, 2, inner)]);
    const read = readFrame(frame);
    expect(read.json.length).toBeGreaterThanOrEqual(1);
    const obj = read.json.find((x) => typeof x === 'object' && x !== null && 'text' in (x as object)) as { text: string };
    expect(obj.text).toBe('hello');
    expect(read.strings).toContain('0:1:2:3');
  });

  it('reads a plain JSON frame', () => {
    const read = readFrame(Buffer.from('{"conversation_id":"c1","message_id":"m1"}'));
    expect(read.json).toHaveLength(1);
  });
});

describe('readBody', () => {
  it('parses JSON answers and strips the anti-JSON prefix', () => {
    const read = readBody(Buffer.from('for (;;);{"status_code":0,"data":{"messages":[]}}'), 'application/json');
    expect((read.json[0] as { status_code: number }).status_code).toBe(0);
  });

  it('falls back to scanning text that is not pure JSON', () => {
    const read = readBody(Buffer.from('{"a":1}\n{"b":2}'), 'text/plain');
    expect(read.json).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------- URLs */

describe('IM URL detection', () => {
  it('accepts TikTok IM endpoints', () => {
    expect(isImUrl('https://www.tiktok.com/api/im/message/list/?count=20')).toBe(true);
    expect(isImUrl('https://www.tiktok.com/tiktok/im/thread/list/')).toBe(true);
    expect(isImUrl('https://imapi.tiktok.com/v1/message/get_by_conversation')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isImUrl('https://www.tiktok.com/api/recommend/item_list/')).toBe(false);
    expect(isImUrl('https://example.com/api/im/message/list/')).toBe(false);
    expect(isImUrl('not a url')).toBe(false);
  });

  it('recognises the message stream socket', () => {
    expect(isImSocket('wss://im-ws.tiktok.com/ws/v2?aid=1988')).toBe(true);
    expect(isImSocket('wss://www.tiktok.com/ws/v2')).toBe(true);
    expect(isImSocket('wss://webcast.tiktok.com/webcast/im/ws')).toBe(false);
  });
});
