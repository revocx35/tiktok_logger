import { describe, expect, it } from 'vitest';
import { findTiktokVideo, isOnlyLink, tiktokVideoId } from './ttLinks';

/**
 * A shared video whose card TikTok dropped arrives as the canonical link (the send falls back to text), and links get
 * pasted by hand — both have to become a playable card, so the id is read out of the text.
 */

describe('ttLinks', () => {
  it('finds the post id in the link shapes TikTok produces', () => {
    expect(tiktokVideoId('https://www.tiktok.com/@anarsianne/video/7699491139375615253')).toBe('7699491139375615253');
    expect(tiktokVideoId('look at this https://www.tiktok.com/@_/video/7412345678901234567?is_from_webapp=1&sender_device=pc ok')).toBe('7412345678901234567');
    expect(tiktokVideoId('https://m.tiktok.com/v/7412345678901234567.html')).toBe('7412345678901234567');
  });

  it('keeps the URL as the message wrote it, so the card can link out', () => {
    const t = 'https://www.tiktok.com/@someone/video/7412345678901234567?lang=en';
    expect(findTiktokVideo(`sent you ${t}`)).toEqual({ id: '7412345678901234567', url: t });
  });

  it('leaves profiles, short links and other sites alone', () => {
    expect(tiktokVideoId('https://www.tiktok.com/@someone')).toBeNull();
    expect(tiktokVideoId('https://vm.tiktok.com/ZMabcdef')).toBeNull();
    expect(tiktokVideoId('https://example.com/@a/video/7412345678901234567')).toBeNull();
    expect(tiktokVideoId(null)).toBeNull();
  });

  it('knows when the text is nothing but the link', () => {
    const url = 'https://www.tiktok.com/@a/video/7412345678901234567';
    expect(isOnlyLink(`  ${url}\n`, url)).toBe(true);
    expect(isOnlyLink(`look ${url}`, url)).toBe(false);
    expect(isOnlyLink(null, url)).toBe(false);
  });
});
