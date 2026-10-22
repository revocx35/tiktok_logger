import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedCommentPage, FeedItem } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { Errors } from '../errors.js';
import { CHAT_ID_PATTERN } from './ids.js';
import { parseRange } from './media.js';

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

  /** The video in view plus the next few: the web and Android clients swipe through these. */
  app.get('/api/feed/window', { config: BROWSING }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(6).default(3) }).parse(req.query);
    return ctx.tt.feed.window(limit);
  });

  /** The client swiped to a video: move the remote page there and hand back a fresh window. */
  app.post('/api/feed/goto', { config: BROWSING }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_:.-]+$/) }).strict().parse(req.body);
    return ctx.tt.feed.goto(id);
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

  /** Share a video into a chat as a TikTok card. */
  app.post('/api/feed/:id/share', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const { chatId } = z.object({ chatId: z.string().regex(CHAT_ID_PATTERN) }).strict().parse(req.body);
    return ctx.tt.feed.share(id, chatId);
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
   * The video or poster, served from the server's cache.
   *
   * The bytes are downloaded once through the browser (and the next videos are already being downloaded in the
   * background), then served whole with a real Content-Length and byte ranges. Both matter on a phone: mobile Safari
   * refuses to play a video that cannot be ranged and hides the duration when the length is not known.
   */
  app.get('/api/feed/media/:ref', { config: BROWSING }, async (req, reply) => {
    const { ref } = RefParam.parse(req.params);
    const f = await ctx.tt.feed.mediaOf(ref);
    if (!f) throw Errors.notFound('Media');
    const size = f.data.length;
    const cacheable = ctx.tt.feed.mediaCached(ref);
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
  });
}
