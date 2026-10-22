import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { ApiFeed } from './feedApi.js';
import { videoPageUrl } from './feed.js';
import type { ShareArgs } from './im/proto.js';
import { makeCtx } from './testutil.js';
import { WebApi, WebApiError } from './web/api.js';

const id = (n: number) => `76000000000000000${String(n).padStart(2, '0')}`;
const item = (n: number) => ({
  id: id(n),
  desc: `caption ${n}`,
  author: { id: `700000000000000${String(n).padStart(3, '0')}`, uniqueId: `user${n}`, nickname: `User ${n}`, secUid: `MS4w.${n}`, avatarThumb: `https://p16.tiktokcdn.com/a${n}.jpeg` },
  video: { playAddr: `https://v16.tiktokcdn.com/v${n}.mp4`, cover: `https://p16.tiktokcdn.com/c${n}.jpg` },
  music: { title: 'sound' },
  stats: { diggCount: 10 * n, commentCount: n, shareCount: 1, playCount: 100 },
  digged: false,
});
const batch = (from: number, n = 6) => JSON.stringify({ status_code: 0, itemList: Array.from({ length: n }, (_, i) => item(from + i)) });

/** A WebApi whose page is a script: records each call and answers from a queue. */
function fakeApi() {
  const calls: { method: string; path: string; extra: Record<string, string> }[] = [];
  let feedAt = 1;
  const api = {
    calls,
    answers: new Map<string, (extra: Record<string, string>) => unknown>(),
    async call(method: string, path: string, extra: Record<string, string>) {
      calls.push({ method, path, extra });
      if (path === '/api/recommend/item_list/') {
        const text = batch(feedAt);
        feedAt += 6;
        return { status: 200, text };
      }
      return { status: 200, text: '' };
    },
    async json(method: string, path: string, extra: Record<string, string>) {
      calls.push({ method, path, extra });
      const h = api.answers.get(path);
      if (!h) throw new WebApiError('no answer', false);
      const r = h(extra);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return api;
}

describe('ApiFeed', () => {
  let ctx: AppContext;
  let cleanup: () => Promise<void>;
  let api: ReturnType<typeof fakeApi>;
  let feed: ApiFeed;
  /** The page path that clicks TikTok's own like control; a like is only as real as what that reports. */
  let likePage: { calls: { id: string; want: boolean }[]; answer: (id: string, want: boolean) => Promise<{ liked: boolean }> };

  beforeEach(async () => {
    const made = await makeCtx();
    ctx = made.ctx;
    cleanup = made.cleanup;
    api = fakeApi();
    likePage = { calls: [], answer: (id2, want) => Promise.resolve({ liked: want }) };
    feed = new ApiFeed(ctx, () => api as unknown as WebApi, () => null, (vid, want) => {
      likePage.calls.push({ id: vid, want });
      return likePage.answer(vid, want);
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('starts on the first video of a fresh batch and hands the client the ones after it', async () => {
    const w = await feed.window(3);
    expect(w.current).toBe(id(1));
    expect(w.items.map((i) => i.id)).toEqual([id(1), id(2), id(3)]);
    expect(w.items[0]).toMatchObject({ caption: 'caption 1', author: { username: 'user1', name: 'User 1' }, liked: false, stats: { likes: 10, comments: 1 } });
    expect(w.items[0]!.video!.src).toMatch(/^\/api\/feed\/media\/[0-9a-f]{24}$/);
    // The page is never asked for anything but the list.
    expect(api.calls.every((c) => c.path === '/api/recommend/item_list/')).toBe(true);
  });

  it('answers a swipe from memory, tops the list up in the background, and does not hammer TikTok', async () => {
    await feed.window(3);
    // 5 videos follow the first one: fewer than the 6 wanted → one more batch is requested right away.
    await new Promise((res) => setTimeout(res, 20));
    const feedCalls = () => api.calls.filter((c) => c.path === '/api/recommend/item_list/').length;
    expect(feedCalls()).toBe(2);
    const r = await feed.goto(id(2));
    expect(r.current).toBe(id(2));
    expect(r.items.map((i) => i.id)).toEqual([id(2), id(3), id(4), id(5), id(6)]);
    await feed.goto(id(3));
    await new Promise((res) => setTimeout(res, 20));
    expect(feedCalls()).toBe(2); // swiping around inside what is loaded costs nothing
    expect((await feed.goto(id(8))).items.length).toBeGreaterThan(1);
    await expect(feed.goto('7600000000000099999')).rejects.toMatchObject({ code: 'feed_moved' });
  });

  it('shares a video as a card whose thumb is the author avatar (the cover there gets dropped)', async () => {
    await feed.window(3);
    const sent: ShareArgs[] = [];
    ctx.tt = {
      ...ctx.tt,
      sender: { ...ctx.tt.sender, sendShare: async (_chatId: string, share: ShareArgs) => (void sent.push(share), { id: '1' }) },
    };
    await feed.share(id(1), '0:1:7000000000000000001:7000000000000000002');
    expect(sent[0]).toMatchObject({
      itemId: id(1),
      // TikTok's own DM share dialog puts the author's avatar in content_thumb; a card with the video cover there is
      // accepted and never stored.
      thumb: { urls: ['https://p16.tiktokcdn.com/a1.jpeg'] },
      cover: { urls: ['https://p16.tiktokcdn.com/c1.jpg'] },
    });
  });

  it('steps forward and back, and does not step before the start', async () => {
    await feed.window(3);
    expect((await feed.step('next')).id).toBe(id(2));
    expect((await feed.step('next')).id).toBe(id(3));
    expect((await feed.step('prev')).id).toBe(id(2));
    await feed.step('prev');
    await expect(feed.step('prev')).rejects.toMatchObject({ code: 'feed_step' });
  });

  it('likes through the page control, never the digg API, and stores what the page shows', async () => {
    await feed.window(3);
    expect(await feed.like(id(2), true)).toEqual({ liked: true });
    expect(likePage.calls).toEqual([{ id: id(2), want: true }]);
    // `POST /api/commit/item/digg/` answers 403 "Web SDK blocked by Argus TLB Plugin" (live, 2026-10-23).
    expect(api.calls.filter((c) => c.path === '/api/commit/item/digg/')).toHaveLength(0);
    expect((await feed.goto(id(1))).items.find((i) => i.id === id(2))).toMatchObject({ liked: true, stats: { likes: 21 } });

    await feed.like(id(2), false);
    expect(likePage.calls.at(-1)).toEqual({ id: id(2), want: false });
    const n = likePage.calls.length;
    await feed.like(id(2), false); // already so: the page is not touched
    expect(likePage.calls.length).toBe(n);

    // A click TikTok ignored is reported as it is, not as the like the client asked for.
    likePage.answer = async () => ({ liked: false });
    expect(await feed.like(id(3), true)).toEqual({ liked: false });
    expect((await feed.goto(id(3))).items[0]!.liked).toBe(false);

    // The page's own refusal (409) reaches the client unchanged; anything else becomes the route's 'like' error.
    likePage.answer = async () => {
      throw new AppError(409, 'feed_moved', 'That video is not in the feed any more.');
    };
    await expect(feed.like(id(3), true)).rejects.toMatchObject({ code: 'feed_moved' });
    likePage.answer = async () => {
      throw new Error('the page is gone');
    };
    await expect(feed.like(id(3), true)).rejects.toMatchObject({ code: 'like' });
  });

  it('reads comments with their replies', async () => {
    api.answers.set('/api/comment/list/', (x) => ({
      status_code: 0,
      comments: [{ cid: 'c1', text: 'nice', digg_count: 4, user: { unique_id: 'ali', nickname: 'Ali' }, reply_comment: [{ cid: 'c2', text: 'thanks', digg_count: 0, user: { unique_id: 'me' } }] }, { cid: 'c3', text: 'second', user: {} }],
      _asked: x.aweme_id,
    }));
    const list = await feed.comments(id(1));
    expect(api.calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/comment/list/', extra: { aweme_id: id(1), from_page: 'video' } });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'c1', text: 'nice', likes: 4, author: { username: 'ali', name: 'Ali' }, replies: [{ id: 'c2', text: 'thanks' }] });
    expect(list[1]).toMatchObject({ id: 'c3', likes: null, author: { username: null } });
  });

  it('posts a comment with the text in the query, audits it once, and returns it with the list', async () => {
    api.answers.set('/api/comment/publish/', () => ({ status_code: 0, comment: { cid: 'new1', text: 'hello there', user: { unique_id: 'me' } } }));
    api.answers.set('/api/comment/list/', () => ({ status_code: 0, comments: [{ cid: 'c1', text: 'old', user: {} }] }));
    const list = await feed.comment(id(1), ' hello there ');
    expect(api.calls.find((c) => c.path === '/api/comment/publish/')).toMatchObject({ method: 'POST', extra: { aweme_id: id(1), text: 'hello there', text_extra: '[]' } });
    expect(list.map((c) => c.id)).toEqual(['new1', 'c1']);
    expect(ctx.repo.listAudit(5).filter((a) => a.event === 'feed_comment')).toHaveLength(1);
    await expect(feed.comment(id(1), '   ')).rejects.toMatchObject({ code: 'validation' });
    await expect(feed.comment(id(1), 'x'.repeat(151))).rejects.toMatchObject({ code: 'validation' });
    api.answers.set('/api/comment/publish/', () => new WebApiError('comment too fast', false, 2));
    await expect(feed.comment(id(1), 'again')).rejects.toMatchObject({ code: 'comment' });
    expect(ctx.repo.listAudit(10).filter((a) => a.event === 'feed_comment')).toHaveLength(1);
  });

  it('is unavailable (not broken) while TikTok is not connected', async () => {
    const off = new ApiFeed(ctx, () => null, () => null, () => Promise.reject(new Error('no page')));
    await expect(off.window()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('videoPageUrl', () => {
  it('builds the video page a like is made on', () => {
    expect(videoPageUrl('https://www.tiktok.com', 'alice', '760000000000000001')).toBe('https://www.tiktok.com/@alice/video/760000000000000001');
    expect(videoPageUrl('https://www.tiktok.com/', 'alice', '76')).toBe('https://www.tiktok.com/@alice/video/76');
    expect(videoPageUrl('http://tiktok.test:8080', null, '76')).toBe('http://tiktok.test:8080/video/76');
  });
});

describe('WebApi', () => {
  const mk = (r: { status: number; text: string; error?: string }) => new WebApi({ evaluate: async () => r as never });

  it('treats an empty 200 (what TikTok answers to a request it does not like) as a failure', async () => {
    await expect(mk({ status: 200, text: '' }).json('GET', '/api/x/', {})).rejects.toThrow(/empty/);
    await expect(mk({ status: 403, text: '{}' }).json('GET', '/api/x/', {})).rejects.toThrow(/403/);
    await expect(mk({ status: 200, text: '<html>' }).json('GET', '/api/x/', {})).rejects.toThrow(/JSON/);
    await expect(mk({ status: 200, text: '{"status_code":2,"status_msg":"slow down"}' }).json('POST', '/api/x/', {})).rejects.toMatchObject({ message: 'slow down', code: 2 });
    expect(await mk({ status: 200, text: '{"status_code":0,"a":1}' }).json<{ a: number }>('GET', '/api/x/', {})).toMatchObject({ a: 1 });
    await expect(mk({ status: 0, text: '', error: 'TypeError: Failed to fetch' }).json('GET', '/api/x/', {})).rejects.toThrow(/Failed to fetch/);
  });
});
