import { describe, expect, it } from 'vitest';
import type { FetchOutcome } from './media.js';
import { FeedMedia, MEDIA_MAX_BYTES, pickMime, refOf } from './feedMedia.js';

/** A downloader that records what was asked for and answers with [body]. */
function fakeDl(body = 'video-bytes', mime = 'video/mp4', delayMs = 0) {
  const calls: { url: string; max: number }[] = [];
  const dl = {
    calls,
    fetch: async (url: string, max: number, sink: (chunk: Buffer) => Promise<void>): Promise<FetchOutcome> => {
      calls.push({ url, max });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await sink(Buffer.from(body));
      return { status: 'ok', mime, size: body.length } as FetchOutcome;
    },
  };
  return dl;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('feed media cache', () => {
  it('gives one ref per URL, so the browser can keep the video', () => {
    const m = new FeedMedia();
    const a = m.ref('https://v16.example.com/a.mp4');
    const b = m.ref('https://v16.example.com/a.mp4');
    const c = m.ref('https://v16.example.com/b.mp4');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^\/api\/feed\/media\/[0-9a-f]{24}$/);
    expect(m.urlOf(refOf('https://v16.example.com/a.mp4'))).toBe('https://v16.example.com/a.mp4');
  });

  it('downloads a video once and serves the rest from the cache', async () => {
    const m = new FeedMedia();
    const dl = fakeDl();
    const ref = m.ref('https://v16.example.com/a.mp4').split('/').pop()!;
    const [one, two] = await Promise.all([m.get(ref, dl), m.get(ref, dl)]);
    expect(one?.data.toString()).toBe('video-bytes');
    expect(two?.data.toString()).toBe('video-bytes');
    expect(dl.calls).toHaveLength(1); // concurrent requests share one download
    expect(m.cached(ref)).toBe(true);
    await m.get(ref, dl);
    expect(dl.calls).toHaveLength(1);
  });

  it('prefetches in the background and does not prefetch the same URL twice', async () => {
    const m = new FeedMedia();
    const dl = fakeDl('x', 'video/mp4', 20);
    const url = 'https://v16.example.com/next.mp4';
    const ref = refOf(url);
    expect(m.cached(ref)).toBe(false);
    m.prefetch(url, dl);
    m.prefetch(url, dl);
    await wait(80);
    expect(dl.calls).toHaveLength(1);
    expect(m.cached(ref)).toBe(true);
  });

  it('keeps the visible video from queueing behind prefetches', async () => {
    const m = new FeedMedia(1);
    const dl = fakeDl('x', 'video/mp4', 30);
    m.prefetch('https://v16.example.com/1.mp4', dl);
    m.prefetch('https://v16.example.com/2.mp4', dl);
    await wait(10);
    expect(dl.calls).toHaveLength(1); // the second prefetch was skipped, not queued
  });

  it('guesses the type from the URL when the response has none', () => {
    expect(pickMime(null, 'https://v16.example.com/v/tos/a.mp4?x=1')).toBe('video/mp4');
    expect(pickMime(null, 'https://p16.example.com/a.webp')).toBe('image/webp');
    expect(pickMime('text/html', 'https://x/a.html')).toBeNull();
  });

  it('refuses a file bigger than the limit and forgets unknown refs', async () => {
    const m = new FeedMedia();
    const dl = fakeDl();
    expect(await m.get('0'.repeat(24), dl)).toBeNull();
    const ref = m.ref('https://v16.example.com/a.mp4').split('/').pop()!;
    await m.get(ref, dl);
    expect(dl.calls[0]!.max).toBe(MEDIA_MAX_BYTES);
    m.clear();
    expect(await m.get(ref, dl)).toBeNull();
  });
});
