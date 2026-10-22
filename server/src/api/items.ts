import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TtItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { sendCached } from './ranged.js';

/**
 * One TikTok post by id, for the chat's shared videos and pasted links.
 *
 * `GET /api/items/:id` resolves it through the logged-in tab (`tt/items.ts`), `…/media/video` and `…/media/cover`
 * stream the bytes the app downloaded through the page (ranged, cached). The signed CDN link stays on the server.
 */

const IdParam = z.object({ id: z.string().regex(/^\d{6,24}$/) });
const MediaParam = z.object({ id: z.string().regex(/^\d{6,24}$/), kind: z.enum(['video', 'cover']) });
const BROWSING = { rateLimit: { max: 240, timeWindow: '1 minute' } };

export function registerItemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/items/:id', { config: BROWSING }, async (req): Promise<TtItem> => {
    const { id } = IdParam.parse(req.params);
    return ctx.tt.items.dto(await ctx.tt.items.lookup(id));
  });

  app.get('/api/items/:id/media/:kind', { config: BROWSING }, async (req, reply) => {
    const { id, kind } = MediaParam.parse(req.params);
    const f = await ctx.tt.items.bytes(id, kind);
    if (!f) throw Errors.notFound(kind === 'video' ? 'That post has no video' : 'That post has no cover');
    const ref = `${id}-${kind}`;
    return sendCached(req, reply, f, ref, ctx.tt.items.cached(id, kind));
  });
}
