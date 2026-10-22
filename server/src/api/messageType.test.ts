import { describe, expect, it } from 'vitest';
import { apiType, shareInfo, videoIdOf } from './messageType.js';

/**
 * Every shared TikTok video in the log is stored as `shared_post` and the API used to cast that straight into
 * `MessageType`, so the web UI's render switch matched nothing: the video showed as a bare link (or as nothing).
 * `apiType` is the one place that translation happens now.
 */

describe('apiType', () => {
  it('maps a shared post to share (1873 rows in the live log on 2026-10-23)', () => {
    expect(apiType('shared_post')).toBe('share');
  });

  it('gives a generic media row its real kind from the stored mime', () => {
    expect(apiType('media', 'video/mp4')).toBe('video');
    expect(apiType('media', 'audio/ogg; codecs=opus')).toBe('voice');
    expect(apiType('media', 'image/jpeg')).toBe('image');
    expect(apiType('media', null)).toBe('image');
  });

  it('passes the API types through and never invents one', () => {
    for (const t of ['text', 'image', 'video', 'voice', 'sticker', 'share', 'system', 'unknown'] as const) {
      expect(apiType(t)).toBe(t);
    }
    expect(apiType('unsupported')).toBe('unknown');
    expect(apiType('SlideMessage')).toBe('unknown');
  });
});

describe('shareInfo', () => {
  it('builds the card of a shared video from the IM meta (`aweType` 800 stores itemId and uid)', () => {
    expect(shareInfo('share', 'İbo - Atatürk edit #atatürk', { itemId: '7699491139375615253', uid: '7669567913267840021' })).toEqual({
      kind: 'Video',
      title: 'İbo - Atatürk edit #atatürk',
      subtitle: null,
      caption: null,
      url: 'https://www.tiktok.com/@_/video/7699491139375615253',
      eyebrow: null,
      itemId: '7699491139375615253',
    });
  });

  it('reads the post id out of a URL when only the link was stored', () => {
    const s = shareInfo('share', null, { url: 'https://www.tiktok.com/@someone/video/7412345678901234567?is_from_webapp=1' });
    expect(s).toMatchObject({ itemId: '7412345678901234567', kind: 'Video', url: 'https://www.tiktok.com/@someone/video/7412345678901234567?is_from_webapp=1' });
  });

  it('keeps TikTok’s own card fields when the capture kept them', () => {
    const s = shareInfo('share', 'body title', {
      share: { kind: 'Profile', title: '@someone', subtitle: '2.1M followers', caption: null, url: 'https://www.tiktok.com/@someone', eyebrow: 'Shared with you' },
    });
    expect(s).toEqual({ kind: 'Profile', title: '@someone', subtitle: '2.1M followers', caption: null, url: 'https://www.tiktok.com/@someone', eyebrow: 'Shared with you', itemId: null });
  });

  it('is null for anything that is not a share', () => {
    expect(shareInfo('text', 'hi', null)).toBeNull();
    expect(shareInfo('video', 'watch this', {})).toBeNull();
    expect(shareInfo('share', null, null)).toMatchObject({ kind: 'Link', url: null, itemId: null });
  });
});

describe('videoIdOf', () => {
  it('recognises the canonical, short and mobile link shapes', () => {
    expect(videoIdOf('https://www.tiktok.com/@a/video/7412345678901234567')).toBe('7412345678901234567');
    expect(videoIdOf('https://www.tiktok.com/@_/video/7412345678901234567?lang=en')).toBe('7412345678901234567');
    expect(videoIdOf('https://m.tiktok.com/v/7412345678901234567.html')).toBe('7412345678901234567');
  });

  it('does not mistake a profile or a short link for a post', () => {
    expect(videoIdOf('https://www.tiktok.com/@someone')).toBeNull();
    expect(videoIdOf('https://vm.tiktok.com/ZMabcdef/')).toBeNull();
    expect(videoIdOf('https://example.com/video/123')).toBeNull(); // not a post id shape
    expect(videoIdOf(null)).toBeNull();
  });
});
