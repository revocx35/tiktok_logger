import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeedReplyPage, ProfileVideoPage, TtProfile } from '../../../shared/api.js';
import type { AppContext } from '../context.js';

/**
 * Profiles, follows, reposts, comment threads and downloads (v1.15). Like the feed, nothing here is stored: the routes
 * forward intent to the server's browser and pass TikTok's answer on. Follows and reposts add one audit line each.
 */

const VideoId = z.string().regex(/^\d{6,24}$/);
const CommentId = z.string().regex(/^\d{6,24}$/);
const Username = z.string().regex(/^[A-Za-z0-9_.]{1,40}$/);
const Cursor = z.string().regex(/^\d{1,20}$/).optional();
const BROWSING = { rateLimit: { max: 240, timeWindow: '1 minute' } };
/** Follows and reposts are what TikTok's spam checks watch: a person does not do 30 a minute. */
const ACTING = { rateLimit: { max: 20, timeWindow: '1 minute' } };

export function registerSocialRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/profiles/me', { config: BROWSING }, async (): Promise<TtProfile> => ctx.tt.social.profile('me'));

  app.get('/api/profiles/:username', { config: BROWSING }, async (req): Promise<TtProfile> => {
    const { username } = z.object({ username: Username }).parse(req.params);
    return ctx.tt.social.profile(username);
  });

  app.get('/api/profiles/:username/videos', { config: BROWSING }, async (req): Promise<ProfileVideoPage> => {
    const { username } = z.object({ username: z.union([z.literal('me'), Username]) }).parse(req.params);
    const { tab, cursor } = z.object({ tab: z.enum(['videos', 'reposts', 'liked', 'favorites']).default('videos'), cursor: Cursor }).parse(req.query);
    return ctx.tt.social.profileVideos(username, tab, cursor ?? null);
  });

  app.post('/api/profiles/:username/follow', { config: ACTING }, async (req) => {
    const { username } = z.object({ username: Username }).parse(req.params);
    const { follow } = z.object({ follow: z.boolean() }).strict().parse(req.body);
    return ctx.tt.social.follow(username, follow);
  });

  app.post('/api/feed/:id/repost', { config: ACTING }, async (req) => {
    const { id } = z.object({ id: VideoId }).parse(req.params);
    const { repost } = z.object({ repost: z.boolean() }).strict().parse(req.body);
    return ctx.tt.social.repost(id, repost);
  });

  app.get('/api/feed/:id/comments/:cid/replies', { config: BROWSING }, async (req): Promise<FeedReplyPage> => {
    const { id, cid } = z.object({ id: VideoId, cid: CommentId }).parse(req.params);
    const { cursor } = z.object({ cursor: Cursor }).parse(req.query);
    return ctx.tt.social.replies(id, cid, cursor ?? null);
  });

  app.post('/api/feed/:id/comments/:cid/reply', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req): Promise<FeedReplyPage> => {
    const { id, cid } = z.object({ id: VideoId, cid: CommentId }).parse(req.params);
    const { text, toReply } = z.object({ text: z.string().min(1).max(150), toReply: CommentId.optional() }).strict().parse(req.body);
    return ctx.tt.social.reply(id, cid, text, toReply ?? null);
  });

  app.post('/api/feed/:id/comments/:cid/like', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id, cid } = z.object({ id: VideoId, cid: CommentId }).parse(req.params);
    const { like } = z.object({ like: z.boolean() }).strict().parse(req.body);
    return ctx.tt.social.likeComment(id, cid, like);
  });

  /** The video as a file: same bytes as the player's, sent as an attachment. */
  app.get('/api/feed/:id/download', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: VideoId }).parse(req.params);
    const f = await ctx.tt.social.download(id);
    return reply
      .header('content-type', f.mime)
      .header('content-length', String(f.data.length))
      .header('content-disposition', `attachment; filename="${f.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(f.data);
  });
}
