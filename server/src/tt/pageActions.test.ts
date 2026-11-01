import { describe, expect, it } from 'vitest';
import { followStateOf, profileUrl, repostStateOf, validUsername } from './pageActions.js';

describe('page actions', () => {
  it('reads the profile header button as TikTok labels it', () => {
    expect(followStateOf('Follow', 'Follow TikTok')).toBe(false);
    expect(followStateOf('Follow back', null)).toBe(false);
    expect(followStateOf('Following', 'Following TikTok')).toBe(true);
    expect(followStateOf('Friends', null)).toBe(true);
    expect(followStateOf('Message', null)).toBeNull();
  });

  it('reads the repost control by its label (live: "Repost" / "Remove repost")', () => {
    expect(repostStateOf('Repost')).toBe(false);
    expect(repostStateOf('Remove repost')).toBe(true);
    expect(repostStateOf('Share')).toBeNull();
  });

  it('only builds profile URLs for real usernames', () => {
    expect(validUsername('some.user_1')).toBe(true);
    expect(validUsername('../x')).toBe(false);
    expect(validUsername('a b')).toBe(false);
    expect(profileUrl('https://www.tiktok.com/', 'tiktok')).toBe('https://www.tiktok.com/@tiktok');
  });
});
