import { describe, expect, it } from 'vitest';
import type { AppContext } from '../context.js';
import { parseItemDetail, TtItems } from './items.js';
import type { WebApi } from './web/api.js';

/**
 * The chat's playable post: `GET /api/item/detail/?itemId=…` from the messages tab (live shape probed on 2026-10-23 —
 * the fixture below is pruned from that answer, not invented).
 */

/** `itemInfo.itemStruct` as TikTok answered it for a video post. */
const LIVE = {
  status_code: 0,
  statusCode: 0,
  status_msg: '',
  itemInfo: {
    itemStruct: {
      id: '7699491139375615253',
      desc: 'İbo - Atatürk edit #atatürk #kemalizm',
      createTime: 1792680000,
      author: { id: '7669567913267840021', uniqueId: 'anarsianne', nickname: 'anar', secUid: 'MS4wLjABAAAAU0DP0tsh', avatarThumb: 'https://p16-sign.tiktokcdn.com/avatar.jpeg' },
      stats: { diggCount: 38, commentCount: 14, shareCount: 15, playCount: 470, collectCount: 6 },
      video: {
        id: 'v12044gd0000',
        playAddr: 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/abc/?a=1988&mime_type=video_mp4',
        cover: 'https://p16-sign.tiktokcdn.com/obj/tos-maliva-p-0068/cover.jpeg',
        originCover: 'https://p16-sign.tiktokcdn.com/obj/tos-maliva-p-0068/origin.jpeg',
        duration: 21,
        width: 1080,
        height: 1920,
        format: 'mp4',
      },
    },
  },
};

/** A photo post: no play address at all. */
const PHOTO = { status_code: 0, itemInfo: { itemStruct: { id: '7412345678901234567', desc: 'two pictures', author: { id: '1', uniqueId: 'someone' }, stats: {}, video: { cover: 'https://p16-sign.tiktokcdn.com/obj/photo.jpeg', width: 1080, height: 1440 } } } };

/** What TikTok answers for an id it does not have (seen live: 200, status_code 0, no itemStruct). */
const GONE = { extra: { fatal_item_ids: [], logid: '20261023023432B35F65E6B61990156372' }, statusCode: 10204, status_code: 0, status_msg: '' };

const fakeApi = (answer: (id: string) => unknown): { api: WebApi; calls: string[] } => {
  const calls: string[] = [];
  const api = {
    json: async (_method: string, path: string, extra: Record<string, string>) => {
      calls.push(`${path}?itemId=${extra.itemId}`);
      return answer(extra.itemId!) as Record<string, unknown>;
    },
  } as unknown as WebApi;
  return { api, calls };
};

const ctx = { log: { warn: () => undefined } } as unknown as AppContext;

describe('parseItemDetail', () => {
  it('reads the live video shape', () => {
    expect(parseItemDetail(LIVE)).toEqual({
      id: '7699491139375615253',
      url: 'https://www.tiktok.com/@anarsianne/video/7699491139375615253',
      desc: 'İbo - Atatürk edit #atatürk #kemalizm',
      author: { id: '7669567913267840021', username: 'anarsianne', name: 'anar' },
      stats: { likes: 38, comments: 14, shares: 15, plays: 470 },
      durationSec: 21,
      width: 1080,
      height: 1920,
      playAddr: 'https://v16-webapp-prime.tiktok.com/video/tos/alisg/abc/?a=1988&mime_type=video_mp4',
      cover: 'https://p16-sign.tiktokcdn.com/obj/tos-maliva-p-0068/cover.jpeg',
    });
  });

  it('accepts a photo post (no play address) and a canonical url without a username', () => {
    expect(parseItemDetail(PHOTO)).toMatchObject({ id: '7412345678901234567', playAddr: null, cover: 'https://p16-sign.tiktokcdn.com/obj/photo.jpeg', url: 'https://www.tiktok.com/@someone/video/7412345678901234567' });
    expect(parseItemDetail({ itemInfo: { itemStruct: { id: '7412345678901234567' } } })).toMatchObject({ url: 'https://www.tiktok.com/@_/video/7412345678901234567', playAddr: null });
  });

  it('is null for a post TikTok does not have', () => {
    expect(parseItemDetail(GONE)).toBeNull();
    expect(parseItemDetail({})).toBeNull();
    expect(parseItemDetail(null)).toBeNull();
    expect(parseItemDetail({ itemInfo: { itemStruct: { id: 'abc' } } })).toBeNull();
  });
});

describe('TtItems', () => {
  it('resolves a post, exposes app routes for its media and caches the answer', async () => {
    const { api, calls } = fakeApi(() => LIVE);
    const dl = { fetch: async () => ({ ok: true }) as never };
    const items = new TtItems(ctx, { api: () => api, downloader: () => dl });

    const item = await items.lookup('7699491139375615253');
    const dto = items.dto(item);
    expect(dto).toMatchObject({
      id: '7699491139375615253',
      url: 'https://www.tiktok.com/@anarsianne/video/7699491139375615253',
      desc: 'İbo - Atatürk edit #atatürk #kemalizm',
      author: { username: 'anarsianne', name: 'anar' },
      stats: { likes: 38, plays: 470 },
      durationSec: 21,
      videoUrl: '/api/items/7699491139375615253/media/video',
      coverUrl: '/api/items/7699491139375615253/media/cover',
      ready: false,
    });
    // The signed CDN links never leave the server.
    expect(JSON.stringify(dto)).not.toContain('tiktokcdn.com');
    expect(JSON.stringify(dto)).not.toContain('v16-webapp-prime');

    await items.lookup('7699491139375615253');
    expect(calls).toEqual(['/api/item/detail/?itemId=7699491139375615253']);
  });

  it('reports a deleted or private post as not found, and a photo post as having no video', async () => {
    const items = new TtItems(ctx, { api: () => fakeApi(() => GONE).api, downloader: () => null });
    await expect(items.lookup('7000000000000000000')).rejects.toMatchObject({ statusCode: 404, code: 'not_found' });

    const photo = new TtItems(ctx, { api: () => fakeApi(() => PHOTO).api, downloader: () => null });
    const dto = photo.dto(await photo.lookup('7412345678901234567'));
    expect(dto.videoUrl).toBeNull();
    expect(dto.coverUrl).toBe('/api/items/7412345678901234567/media/cover');
    await expect(photo.bytes('7412345678901234567', 'video')).resolves.toBeNull();
  });

  it('refuses a malformed id without asking TikTok, and says so when TikTok is not connected', async () => {
    const { api, calls } = fakeApi(() => LIVE);
    const items = new TtItems(ctx, { api: () => api, downloader: () => null });
    await expect(items.lookup('../../etc/passwd')).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toEqual([]);

    const offline = new TtItems(ctx, { api: () => null, downloader: () => null });
    await expect(offline.lookup('7699491139375615253')).rejects.toMatchObject({ statusCode: 503 });
  });
});
