/**
 * Minimal protobuf wire reader/writer and the LZ4 block decoder TikTok's IM socket uses.
 *
 * TikTok's web IM speaks protobuf (see docs/tiktok-notes.md "The IM protocol"). The schema is reverse-engineered and
 * partial, so nothing here is generated: requests are written field by field and answers are read as a list of
 * `{n, wt, v|b}` and picked apart where we know what a field means. Everything read comes from the network, so every
 * reader is bounded and throws a plain Error on garbage (callers treat that as "not this kind of frame").
 */

export interface Field {
  /** Field number. */
  n: number;
  /** Wire type: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
  wt: number;
  /** wt 0 */
  v?: bigint;
  /** wt 2 (a view into the input; copy before keeping) */
  b?: Buffer;
}

const MAX_FIELDS = 20_000;

export function readFields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < buf.length) {
    if (out.length >= MAX_FIELDS) throw new Error('too many fields');
    const key = readVarint(buf, i);
    i = key.next;
    const n = Number(key.value >> 3n);
    const wt = Number(key.value & 7n);
    if (n <= 0 || n > 536_870_911) throw new Error('bad field number');
    if (wt === 0) {
      const v = readVarint(buf, i);
      i = v.next;
      out.push({ n, wt, v: v.value });
    } else if (wt === 2) {
      const len = readVarint(buf, i);
      i = len.next;
      const l = Number(len.value);
      if (len.value > BigInt(buf.length) || i + l > buf.length) throw new Error('truncated field');
      out.push({ n, wt, b: buf.subarray(i, i + l) });
      i += l;
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error('truncated fixed64');
      out.push({ n, wt });
      i += 8;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error('truncated fixed32');
      out.push({ n, wt });
      i += 4;
    } else throw new Error('unsupported wire type');
  }
  return out;
}

function readVarint(buf: Buffer, start: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

/** First varint with this number, as a decimal string ('' when absent). Ids are 64-bit: never a JS number. */
export function num(fs: Field[], n: number): string {
  const f = fs.find((x) => x.n === n && x.wt === 0);
  return f?.v !== undefined ? f.v.toString() : '';
}

export function bytesOf(fs: Field[], n: number): Buffer | undefined {
  return fs.find((x) => x.n === n && x.wt === 2)?.b;
}

export function str(fs: Field[], n: number): string {
  const b = bytesOf(fs, n);
  return b ? b.toString('utf8') : '';
}

export function allBytes(fs: Field[], n: number): Buffer[] {
  return fs.filter((x) => x.n === n && x.wt === 2).map((x) => x.b!);
}

/** A nested message, or null when the field is absent or does not parse. */
export function sub(fs: Field[], n: number): Field[] | null {
  const b = bytesOf(fs, n);
  if (!b) return null;
  try {
    return readFields(b);
  } catch {
    return null;
  }
}

export function subs(fs: Field[], n: number): Field[][] {
  const out: Field[][] = [];
  for (const b of allBytes(fs, n)) {
    try {
      out.push(readFields(b));
    } catch {
      /* skip the row that does not parse */
    }
  }
  return out;
}

export class PbWriter {
  private readonly parts: Buffer[] = [];

  private key(n: number, wt: number): void {
    this.parts.push(varintBytes((BigInt(n) << 3n) | BigInt(wt)));
  }

  /** Always written, zero included (TikTok's client sets these fields explicitly). */
  u64(n: number, v: number | bigint): this {
    this.key(n, 0);
    this.parts.push(varintBytes(BigInt(v)));
    return this;
  }

  bytes(n: number, b: Buffer | Uint8Array): this {
    this.key(n, 2);
    this.parts.push(varintBytes(BigInt(b.length)), Buffer.from(b));
    return this;
  }

  string(n: number, s: string): this {
    return this.bytes(n, Buffer.from(s, 'utf8'));
  }

  message(n: number, w: PbWriter | Buffer): this {
    return this.bytes(n, w instanceof PbWriter ? w.build() : w);
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function varintBytes(v: bigint): Buffer {
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/**
 * LZ4 *block* decompression (no frame header): TikTok marks compressed socket payloads with `__lz4` and does not carry
 * the output size, so the caller bounds it. Throws on a malformed block.
 */
export function lz4Block(src: Buffer, maxOut = 8 * 1024 * 1024): Buffer {
  let buf = Buffer.allocUnsafe(Math.min(maxOut, Math.max(1024, src.length * 8)));
  let o = 0;
  let i = 0;
  const ensure = (need: number) => {
    if (o + need <= buf.length) return;
    if (o + need > maxOut) throw new Error('lz4 output too large');
    const bigger = Buffer.allocUnsafe(Math.min(maxOut, Math.max(buf.length * 2, o + need)));
    buf.copy(bigger, 0, 0, o);
    buf = bigger;
  };
  while (i < src.length) {
    const token = src[i++]!;
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        if (i >= src.length) throw new Error('lz4 truncated');
        b = src[i++]!;
        lit += b;
      } while (b === 255);
    }
    if (i + lit > src.length) throw new Error('lz4 truncated literals');
    ensure(lit);
    src.copy(buf, o, i, i + lit);
    o += lit;
    i += lit;
    if (i >= src.length) break; // the last sequence has no match
    if (i + 2 > src.length) throw new Error('lz4 truncated offset');
    const offset = src[i]! | (src[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error('lz4 bad offset');
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        if (i >= src.length) throw new Error('lz4 truncated');
        b = src[i++]!;
        len += b;
      } while (b === 255);
    }
    len += 4;
    ensure(len);
    for (let k = 0; k < len; k++) buf[o + k] = buf[o - offset + k]!; // may overlap: byte by byte
    o += len;
  }
  return Buffer.from(buf.subarray(0, o));
}
