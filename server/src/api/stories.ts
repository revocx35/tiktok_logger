import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StoryAccount, StoryAuthor, StoryItem, StoryPage } from '../../../shared/api.js';
import type { AppContext } from '../context.js';
import { F } from '../db/repo.js';
import { getReader } from '../http/server.js';

/**
 * Logged stories (see tt/stories.ts): the authors seen in TikTok's stories bar, the items captured for them, their
 * status and a "check now". Media is served by the normal media route (`/api/media/:id`), so a story photo or video is
 * decrypted and ranged exactly like a logged message's.
 */
export function registerStoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo } = ctx;

  app.get('/api/stories/status', async () => ctx.tt.stories.status());

  app.post('/api/stories/check', { config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (req) => {
    repo.audit('stories_checked', req.ip);
    return ctx.tt.stories.checkNow({ manual: true });
  });

  app.get('/api/stories/authors', async (req) => {
    const reader = getReader(ctx, req);
    const list: StoryAuthor[] = repo.listStoryUsers().map((u) => ({
      id: u.id,
      username: reader.tryText(...F.storyUsername(u.id), u.username_enc),
      name: reader.tryText(...F.storyName(u.id), u.name_enc),
      avatarUrl: u.avatar_media_id ? `/api/media/${u.avatar_media_id}` : null,
      count: u.count,
      latest: u.latest,
    }));
    return list;
  });

  /** Every account seen in the stories bar, so the owner can choose whose stories are logged. */
  app.get('/api/stories/accounts', async (req) => {
    const reader = getReader(ctx, req);
    const chosen = new Set(ctx.settings.get().storySelected);
    const list: StoryAccount[] = repo
      .listKnownStoryUsers()
      .map((u) => ({
        id: u.id,
        username: reader.tryText(...F.storyUsername(u.id), u.username_enc),
        name: reader.tryText(...F.storyName(u.id), u.name_enc),
        avatarUrl: u.avatar_media_id ? `/api/media/${u.avatar_media_id}` : null,
        count: u.count,
        selected: chosen.has(u.id),
      }))
      .sort((a, b) => (a.username ?? a.id).localeCompare(b.username ?? b.id));
    return list;
  });

  app.get('/api/stories', async (req) => {
    const q = z
      .object({
        user: z.string().regex(/^\d{6,24}$/).optional(),
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .strict()
      .parse(req.query);
    const reader = getReader(ctx, req);
    const names = new Map<string, { username: string | null; name: string | null }>();
    const who = (id: string) => {
      if (!names.has(id)) {
        const u = repo.getStoryUser(id);
        names.set(id, {
          username: u ? reader.tryText(...F.storyUsername(id), u.username_enc) : null,
          name: u ? reader.tryText(...F.storyName(id), u.name_enc) : null,
        });
      }
      return names.get(id)!;
    };
    const rows = repo.listStories({ userId: q.user ?? null, before: q.before ?? null, limit: q.limit });
    const items: StoryItem[] = rows.map((r) => {
      const me = who(r.user_id);
      const media = r.media_id ? repo.getMedia(r.media_id) : null;
      return {
        id: r.id,
        userId: r.user_id,
        username: me.username,
        name: me.name,
        type: r.type,
        takenAt: r.taken_at,
        expiresAt: r.expires_at,
        status: r.status,
        url: r.status === 'downloaded' && r.media_id ? `/api/media/${r.media_id}` : null,
        mime: media ? reader.tryText(...F.mediaMime(media.path), media.mime_enc) : null,
        likes: r.likes,
        plays: r.plays,
      };
    });
    const page: StoryPage = { items, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.taken_at : null };
    return page;
  });
}
