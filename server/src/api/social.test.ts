import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NullTt, type TtSocial } from '../context.js';
import { makeHarness, type Harness, type TestClient } from '../testutil/harness.js';

/** The v1.15 routes: auth + CSRF like every route, strict validation before anything reaches the browser. */
describe('social routes', () => {
  let h: Harness;
  let c: TestClient;
  const seen: unknown[][] = [];

  beforeEach(async () => {
    seen.length = 0;
    const social: TtSocial = {
      profile: async (u) => (seen.push(['profile', u]), { id: '1', username: String(u), name: null, avatar: null, bio: null, link: null, verified: false, private: false, me: u === 'me', following: false, friends: false, stats: { followers: 1, following: 1, likes: 1, videos: 1 }, tabs: ['videos'], url: 'https://www.tiktok.com/@x' }),
      profileVideos: async (u, tab, cursor) => (seen.push(['videos', u, tab, cursor]), { items: [], cursor: null, more: false }),
      follow: async (u, want) => (seen.push(['follow', u, want]), { following: want }),
      repost: async (id, want) => (seen.push(['repost', id, want]), { reposted: want }),
      replies: async (id, cid, cursor) => (seen.push(['replies', id, cid, cursor]), { comments: [], cursor: null, more: false }),
      reply: async (id, cid, text, to) => (seen.push(['reply', id, cid, text, to]), { comments: [], cursor: null, more: false }),
      likeComment: async (id, cid, want) => (seen.push(['clike', id, cid, want]), { liked: want }),
      download: async (id) => (seen.push(['download', id]), { mime: 'video/mp4', data: Buffer.from('mp4bytes'), filename: `tiktok-a-${id}.mp4` }),
    };
    class FakeTt extends NullTt {
      override readonly social = social;
    }
    h = await makeHarness({}, { tt: () => new FakeTt() });
    c = h.client();
    await c.signup();
  });
  afterEach(async () => {
    await h.close();
  });

  it('needs a session and the CSRF token', async () => {
    expect((await h.client().req('GET', '/api/profiles/me')).status).toBe(401);
    expect((await c.req('POST', '/api/profiles/someone/follow', { follow: true }, { csrf: null })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('forwards valid requests and refuses malformed ones before the browser sees them', async () => {
    expect((await c.req('GET', '/api/profiles/me')).body).toMatchObject({ me: true });
    expect((await c.req('GET', '/api/profiles/some.user_1')).status).toBe(200);
    expect((await c.req('GET', '/api/profiles/bad%20name')).status).toBe(400);
    expect((await c.req('GET', '/api/profiles/me/videos?tab=liked&cursor=17300')).status).toBe(200);
    expect((await c.req('GET', '/api/profiles/x/videos?tab=drafts')).status).toBe(400);
    expect((await c.req('GET', '/api/profiles/x/videos?cursor=abc')).status).toBe(400);
    expect((await c.req('POST', '/api/profiles/x/follow', { follow: 'yes' })).status).toBe(400);
    expect((await c.req('POST', '/api/profiles/x/follow', { follow: true })).body).toEqual({ following: true });
    expect((await c.req('POST', '/api/feed/7600000000000000001/repost', { repost: true })).body).toEqual({ reposted: true });
    expect((await c.req('POST', '/api/feed/f:synthetic/repost', { repost: true })).status).toBe(400);
    expect((await c.req('GET', '/api/feed/7600000000000000001/comments/7300000000000000001/replies?cursor=20')).status).toBe(200);
    expect((await c.req('POST', '/api/feed/7600000000000000001/comments/7300000000000000001/reply', { text: 'x'.repeat(151) })).status).toBe(400);
    expect((await c.req('POST', '/api/feed/7600000000000000001/comments/7300000000000000001/reply', { text: 'hi', toReply: '7300000000000000002' })).status).toBe(200);
    expect((await c.req('POST', '/api/feed/7600000000000000001/comments/7300000000000000001/like', { like: false })).body).toEqual({ liked: false });
    expect(seen).toEqual([
      ['profile', 'me'],
      ['profile', 'some.user_1'],
      ['videos', 'me', 'liked', '17300'],
      ['follow', 'x', true],
      ['repost', '7600000000000000001', true],
      ['replies', '7600000000000000001', '7300000000000000001', '20'],
      ['reply', '7600000000000000001', '7300000000000000001', 'hi', '7300000000000000002'],
      ['clike', '7600000000000000001', '7300000000000000001', false],
    ]);
  });

  it('sends a download as an attachment that is never cached', async () => {
    const r = await c.req('GET', '/api/feed/7600000000000000001/download');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toBe('attachment; filename="tiktok-a-7600000000000000001.mp4"');
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.raw).toBe('mp4bytes');
  });
});
