import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseRange } from './media.js';

/**
 * Sends a whole in-memory video/poster with a real `Content-Length` and byte ranges, which is what a phone needs:
 * mobile Safari refuses to play a video that cannot be ranged and hides the duration when the length is unknown.
 *
 * Shared by the feed's videos and a chat card's post (`/api/items/:id/media/:kind`), so both answer ranges the same way.
 */
export function sendCached(req: FastifyRequest, reply: FastifyReply, f: { mime: string; data: Buffer }, ref: string, cacheable: boolean): FastifyReply {
  const size = f.data.length;
  reply
    .header('content-type', f.mime)
    .header('cache-control', cacheable ? 'private, max-age=3600' : 'private, max-age=60')
    .header('x-content-type-options', 'nosniff')
    .header('accept-ranges', 'bytes')
    .header('etag', `"${ref}-${size}"`);
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    reply.code(416).header('content-range', `bytes */${size}`);
    return reply.send();
  }
  if (!range) {
    reply.header('content-length', String(size));
    return reply.send(f.data);
  }
  reply
    .code(206)
    .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
    .header('content-length', String(range.end - range.start + 1));
  return reply.send(f.data.subarray(range.start, range.end + 1));
}
