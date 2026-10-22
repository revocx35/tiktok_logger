import { afterEach, describe, expect, it } from 'vitest';
import { F } from '../db/repo.js';
import { makeCtx } from './testutil.js';
import { StoryLogger, parseBatch, parseTray, storyDelay, type StoryDeps } from './stories.js';
import type { WebApi } from './web/api.js';

/**
 * The story parsers (shapes taken from live answers, see docs/tiktok-notes.md) and the logger's own rules: an item is
 * stored once, the retention sweep deletes old stories with their media, and nothing is fetched while logging is off.
 */

const trayAnswer = (users: unknown[], cursor = '2', hasMore = false) => ({ storyUsers: users, cursor, hasMore, statusCode: 0 });
const user = (id: string, uniqueId: string, nickname = 'Someone', avatarMedium = 'https://p16.example.com/a.jpg') => ({
  stats: { diggCount: 1 },
  user: { id, uniqueId, nickname, avatarMedium, avatarLarger: 'https://p16.example.com/big.jpg' },
});

const videoItem = (id: string) => ({
  id,
  createTime: 1792638760,
  desc: '',
  video: { playAddr: `https://v16-webapp-prime.tiktok.com/video/${id}.mp4`, duration: 10, width: 576, height: 1024 },
  story: { ExpiredAt: 1792725160000, Viewed: false },
  stats: { diggCount: 7, playCount: 88, commentCount: 0, shareCount: 2, collectCount: 0 },
});

const photoItem = (id: string) => ({
  id,
  createTime: 1792638000,
  imagePost: { images: [{ imageURL: 'https://p16.example.com/small.jpg', imageWidth: 720 }, { imageURL: 'https://p16.example.com/big.jpg', imageWidth: 1080 }] },
  story: { ExpiredAt: 1792724400000 },
  stats: { diggCount: 1, playCount: 2 },
});

const batchAnswer = (authorId: string, items: unknown[]) => ({
  batchStoryItemLists: [{ AuthorId: authorId, LastStoryCreatedAt: '1792638760009', TotalCount: String(items.length), MaxCursor: '', MinCursor: '', itemList: items }],
});

describe('story parsers', () => {
  it('reads the stories bar and skips entries without a usable id', () => {
    const page = parseTray(trayAnswer([user('7569493869424952327', 'ayse'), { user: { id: 'x' } }, { nope: 1 }]));
    expect(page.users).toHaveLength(1);
    expect(page.users[0]).toMatchObject({ id: '7569493869424952327', username: 'ayse', name: 'Someone' });
    expect(page.users[0]!.avatar).toContain('p16.example.com');
    expect(page.cursor).toBe('2');
    expect(page.hasMore).toBe(false);
  });

  it('reads a video story: play address, expiry and the item numbers', () => {
    const [group] = parseBatch(batchAnswer('7569493869424952327', [videoItem('7412345678901234569')]));
    expect(group!.authorId).toBe('7569493869424952327');
    expect(group!.lastStoryAt).toBe(1792638760009);
    expect(group!.items).toHaveLength(1);
    expect(group!.items[0]).toMatchObject({
      id: '7412345678901234569',
      type: 'video',
      mime: 'video/mp4',
      takenAt: 1792638760000, // seconds → ms
      expiresAt: 1792725160000,
      likes: 7,
      plays: 88,
    });
    expect(group!.items[0]!.url).toContain('/video/7412345678901234569.mp4');
  });

  it('reads a photo story: the biggest candidate, and no play address', () => {
    const [group] = parseBatch(batchAnswer('7569493869424952327', [photoItem('7412345678901234570')]));
    const item = group!.items[0]!;
    expect(item.type).toBe('image');
    expect(item.mime).toBe('image/jpeg');
    expect(item.url).toBe('https://p16.example.com/big.jpg');
  });

  it('drops an item that has no media link at all', () => {
    const [group] = parseBatch(batchAnswer('7569493869424952327', [{ id: '7412345678901234571', createTime: 1, video: {} }]));
    expect(group!.items).toHaveLength(0);
  });

  it('keeps the delay inside the interval ± a quarter of it', () => {
    expect(storyDelay(60, () => 0)).toBe(45 * 60_000);
    expect(storyDelay(60, () => 1)).toBe(75 * 60_000);
    expect(storyDelay(60, () => 0.5)).toBe(60 * 60_000);
  });
});

describe('story logger', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  const make = async () => {
    const made = await makeCtx();
    cleanup = made.cleanup;
    // A fake web API: one author in the bar, one video story, and a downloader that answers with a byte.
    const calls: string[] = [];
    const api = {
      json: async (method: string, path: string) => {
        calls.push(path);
        if (path === '/api/story/user_list/') return trayAnswer([user('7569493869424952327', 'ayse')]);
        return batchAnswer('7569493869424952327', [videoItem('7412345678901234569')]);
      },
      call: async () => ({ status: 200, text: '{}' }),
    } as unknown as WebApi;
    const dl = {
      fetch: async (_url: string, _max: number, sink: (c: Buffer) => Promise<void>) => {
        await sink(Buffer.from('story-bytes'));
        return { status: 'ok' as const, mime: 'video/mp4', size: 11 };
      },
    };
    const deps: StoryDeps = { api: () => api, downloader: () => dl };
    const logger = new StoryLogger(made.ctx, deps);
    return { ctx: made.ctx, logger, calls, reader: made.reader };
  };

  it('does nothing while story logging is off', async () => {
    const { ctx, logger } = await make();
    const status = await logger.checkNow();
    expect(status.items).toBe(0);
    expect(status.logging).toBe(false);
    expect(ctx.repo.countStoriesByStatus().total).toBe(0);
  });

  it('still runs when asked explicitly while the schedule is off', async () => {
    const { ctx, logger } = await make();
    const status = await logger.checkNow({ manual: true });
    expect(status.items).toBe(1);
    expect(ctx.repo.countStoriesByStatus().total).toBe(1);
  });

  it('stores an author, the story, and its media — once', async () => {
    const { ctx, logger } = await make();
    ctx.settings.update({ storyLogging: true, downloadHistoryMedia: true });
    const first = await logger.checkNow();
    expect(first.items).toBe(1);
    expect(first.downloaded).toBe(1);
    const row = ctx.repo.getStory('7412345678901234569');
    expect(row).toMatchObject({ user_id: '7569493869424952327', type: 'video', status: 'downloaded' });
    expect(row!.media_id).toBeGreaterThan(0);
    const stored = ctx.repo.getStoryUser('7569493869424952327');
    expect(stored?.last_story_at).toBe(1792638760009);

    // The same story comes back on the next pass: nothing is duplicated and its media is not downloaded again.
    const second = await logger.checkNow();
    expect(second.items).toBe(1);
    expect(ctx.repo.listStories({ limit: 10 })).toHaveLength(1);
  });

  it('deletes stories past the retention setting, with their file', async () => {
    const { ctx, logger } = await make();
    ctx.settings.update({ storyLogging: true, storyRetentionDays: 7 });
    await logger.checkNow();
    const story = ctx.repo.getStory('7412345678901234569')!;
    const media = ctx.repo.getMedia(story.media_id!)!;
    // Backdate it beyond the retention window.
    ctx.repo.db.prepare('UPDATE stories SET taken_at = ? WHERE id = ?').run(Date.now() - 30 * 24 * 3600_000, story.id);
    const removed = await logger.sweep();
    expect(removed).toBe(1);
    expect(ctx.repo.getStory(story.id)).toBeUndefined();
    expect(ctx.repo.getMedia(media.id)).toBeUndefined();
  });

  it('keeps the identity of an author encrypted, and reports it back through the repo', async () => {
    const { ctx, logger, reader } = await make();
    ctx.settings.update({ storyLogging: true });
    await logger.checkNow();
    const row = ctx.repo.getStoryUser('7569493869424952327')!;
    expect(row.username_enc).toBeInstanceOf(Buffer);
    expect(row.username_enc!.includes(Buffer.from('ayse'))).toBe(false);
    expect(reader.tryText(...F.storyUsername(row.id), row.username_enc)).toBe('ayse');
  });
});
