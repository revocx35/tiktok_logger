/**
 * Reading TikTok's own traffic without knowing its schema.
 *
 * TikTok's web client talks to its IM service over a WebSocket (`wss://im-ws.tiktok.com/ws/v2`) and over HTTP
 * endpoints under `tiktok.com`. The mobile app's protocol is protobuf; the web client's frames carry protobuf
 * envelopes around JSON payloads (the same design Douyin's web client uses: a text frame's content is
 * `{"text":"…","aweType":700,…}` inside a length-delimited field). This module therefore does two things and
 * nothing clever:
 *
 *   1. `walkProto` parses a buffer as a protobuf message *structurally* (field number, wire type, value) without a
 *      .proto file, tolerating unknown fields, and recurses into length-delimited fields that parse completely.
 *   2. `extractJson` finds JSON objects in any text (frames, printable strings inside protobuf, response bodies)
 *      with a brace matcher, so a JSON payload is recovered whatever field it hides in.
 *
 * Everything is bounded (objects, string length, recursion depth, total work) because all of it is untrusted input
 * produced by whatever runs in the browser tab. Nothing here throws on garbage: it returns what it could read.
 */

export interface ProtoField {
  field: number;
  wire: number;
  /** wire 0 */
  value?: bigint;
  /** wire 2 that decoded as UTF-8 text */
  text?: string;
  /** wire 2 that did not decode as text */
  binary?: Buffer;
  /** wire 2 that parsed completely as a nested message */
  children?: ProtoField[];
  /** wire 1 / 5 raw payload length */
  fixed?: number;
}

export interface FrameRead {
  /** JSON objects found anywhere in the frame (in the envelope or in its strings). */
  json: unknown[];
  /** Printable strings found in the envelope, longest first, deduplicated (for diagnostics and id hunting). */
  strings: string[];
  fields: ProtoField[];
}

const MAX_DEPTH = 6;
const MAX_FIELDS = 5000;
const MAX_TEXT = 64 * 1024;
const MAX_JSON_OBJECTS = 200;
const MAX_JSON_BYTES = 512 * 1024;

/** Reads a base-128 varint. Returns null on truncation or an absurd length. */
export function readVarint(buf: Buffer, start: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i]!;
    value |= BigInt(b & 0x7f) << shift;
    i++;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let ok = 0;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b !== 0x7f)) ok++;
  }
  return ok / n;
}

function decodeText(buf: Buffer): string | null {
  if (buf.length === 0 || buf.length > MAX_TEXT) return null;
  if (printableRatio(buf) < 1) return null;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return s;
  } catch {
    return null;
  }
}

/**
 * Parses [buf] as a protobuf message. Returns [] when it is not one. Nested messages are only accepted when the
 * child parses *completely* and has at least one field, which keeps random binary from exploding into fake trees.
 */
export function walkProto(buf: Buffer, depth = 0, budget = { fields: 0 }): ProtoField[] {
  if (depth > MAX_DEPTH) return [];
  const out: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    if (budget.fields >= MAX_FIELDS) break;
    const key = readVarint(buf, i);
    if (!key) break;
    const k = Number(key.value);
    const field = k >>> 3;
    const wire = k & 7;
    if (field === 0 || field > 536_870_911) break;
    i = key.next;
    budget.fields++;
    if (wire === 0) {
      const v = readVarint(buf, i);
      if (!v) break;
      out.push({ field, wire, value: v.value });
      i = v.next;
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      out.push({ field, wire, fixed: 8 });
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire, fixed: 4 });
      i += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) break;
      const n = Number(len.value);
      if (n < 0 || n > buf.length - len.next) break;
      const body = buf.subarray(len.next, len.next + n);
      i = len.next + n;
      const text = decodeText(body);
      const node: ProtoField = { field, wire };
      if (text !== null) {
        node.text = text;
        // A string that is itself a message (a nested envelope encoded as bytes with printable content) is rare;
        // keep it as text. Nested *binary* messages are the common case.
      } else if (body.length > 0) {
        const children = walkProto(body, depth + 1, budget);
        if (children.length > 0) node.children = children;
        else node.binary = body;
      }
      out.push(node);
    } else {
      break; // groups (3/4) are obsolete; anything else means this is not a message
    }
  }
  return out;
}

/** Finds every JSON object in [text] (brace matcher that understands strings and escapes). */
export function extractJson(text: string, limit = MAX_JSON_OBJECTS): unknown[] {
  const out: unknown[] = [];
  if (text.length === 0 || text.length > MAX_JSON_BYTES) return out;
  let i = 0;
  while (i < text.length && out.length < limit) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) break;
    const slice = text.slice(start, end + 1);
    if (slice.length <= MAX_JSON_BYTES) {
      try {
        out.push(JSON.parse(slice));
      } catch {
        /* not JSON after all (a brace in prose): move on */
      }
    }
    i = end + 1;
  }
  return out;
}

/** All printable strings in a proto tree, longest first. */
export function protoStrings(fields: ProtoField[], out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH) return out;
  for (const f of fields) {
    if (f.text !== undefined) out.push(f.text);
    if (f.children) protoStrings(f.children, out, depth + 1);
  }
  return out;
}

/** Reads a binary WebSocket frame (or any buffer) for JSON payloads. */
export function readFrame(buf: Buffer): FrameRead {
  const fields = walkProto(buf);
  const strings = [...new Set(protoStrings(fields))].sort((a, b) => b.length - a.length);
  const json: unknown[] = [];
  const raw = decodeText(buf);
  if (raw) json.push(...extractJson(raw));
  for (const s of strings) {
    if (s.length < 8) continue;
    if (s.includes('{')) json.push(...extractJson(s));
    if (json.length >= MAX_JSON_OBJECTS) break;
  }
  return { json, strings, fields };
}

/** Reads an HTTP response body (JSON text, JSON hidden in text, or protobuf). */
export function readBody(buf: Buffer, contentType: string | null): FrameRead {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json') || ct.includes('text/plain') || ct.includes('javascript')) {
    const text = buf.toString('utf8');
    const json: unknown[] = [];
    const trimmed = text.replace(/^\s*for\s*\(\s*;;\s*\)\s*;/, '');
    try {
      json.push(JSON.parse(trimmed));
    } catch {
      json.push(...extractJson(trimmed));
    }
    return { json, strings: [], fields: [] };
  }
  return readFrame(buf);
}

/** URLs whose answers may carry IM data (conversations, messages, unread counts). */
export function isImUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname) && !/(^|\.)tiktokv\.(com|eu|us)$/i.test(u.hostname)) return false;
    return /\/(api\/)?(im|dm|messaging|chat|conversation|thread|mail)\b/i.test(u.pathname) || /im-ws|imapi/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** The IM push sockets (the web client's message stream). */
export function isImSocket(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /(^|\.)im-ws[^.]*\.tiktok\.com$/i.test(u.hostname) || /(^|\.)tiktok\.com$/i.test(u.hostname) && /\/ws\/v2\b/i.test(u.pathname);
  } catch {
    return false;
  }
}
