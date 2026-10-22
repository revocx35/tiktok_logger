import { PassThrough, once } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedCommentPage, FeedItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';

/**
 * The For You feed: browsing, liking, comments and the video stream. All of it is done by the server's browser; these
 * routes only forward intent and data. Nothing here is stored (the feed is not the log), except one audit line when a
 * comment is posted.
 */

const IdParam = z.object({ id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/) });
const RefParam = z.object({ ref: z.string().regex(/^[0-9a-f]{24}$/) });
const BROWSING = { rateLimit: { max: 240, timeWindow: '1 minute' } };

export function registerFeedRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/feed', { config: BROWSING }, async (): Promise<{ item: FeedItem | null }> => {
    return { item: await ctx.tt.feed.current() };
  });

  app.post('/api/feed/step', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { dir } = z.object({ dir: z.enum(['next', 'prev']) }).strict().parse(req.body);
    return { item: await ctx.tt.feed.step(dir) };
  });

  app.post('/api/feed/:id/like', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { like } = z.object({ like: z.boolean() }).strict().parse(req.body);
    return ctx.tt.feed.like(id, like);
  });

  app.get('/api/feed/:id/comments', { config: BROWSING }, async (req): Promise<FeedCommentPage> => {
    const { id } = IdParam.parse(req.params);
    return { comments: await ctx.tt.feed.comments(id) };
  });

  app.post('/api/feed/:id/comment', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req): Promise<FeedCommentPage> => {
    const { id } = IdParam.parse(req.params);
    const { text } = z.object({ text: z.string().min(1).max(150) }).strict().parse(req.body);
    return { comments: await ctx.tt.feed.comment(id, text) };
  });

  app.post('/api/feed/comments/close', { config: BROWSING }, async () => {
    await ctx.tt.feed.closeComments();
    return { ok: true };
  });

  /**
   * The video/poster, streamed through the browser. Signed CDN links never reach the client; the ref is short-lived
   * and only exists while the feed tab is open.
   */
  app.get('/api/feed/media/:ref', { config: BROWSING }, async (req, reply) => {
    const { ref } = RefParam.parse(req.params);
    const mime = ctx.tt.feed.mimeOf(ref);
    const pass = new PassThrough();
    pass.on('error', () => undefined);
    void ctx.tt.feed
      .streamMedia(ref, async (chunk) => {
        if (!pass.write(chunk)) await once(pass, 'drain');
      })
      .then(() => pass.end())
      .catch((err: unknown) => {
        // Nothing has been sent yet when the first fetch fails: let Fastify turn it into a proper error.
        pass.destroy(err instanceof Error ? err : new Error('stream failed'));
      });
    reply
      .header('content-type', mime ?? 'application/octet-stream')
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('accept-ranges', 'none');
    if (req.headers.range) throw Errors.conflict('Seeking is not supported for feed video.');
    return reply.send(pass);
  });
}
