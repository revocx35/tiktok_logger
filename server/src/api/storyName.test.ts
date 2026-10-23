import { describe, expect, it } from 'vitest';
import { storyFileName, uniqueNames } from './media.js';

/**
 * Downloads of logged stories: a story has no original filename, so the name is built from the author and the time.
 * It lands in the browser's downloads (and in the ZIP) as `story_@user_2026-10-23_05-37.jpg`, never `media-123.bin`.
 */
describe('storyFileName', () => {
  it('names a story after its author, time and type', () => {
    const at = Date.UTC(2026, 9, 23, 5, 37, 12);
    expect(storyFileName('ege', at, 'image/jpeg')).toBe('story_@ege_2026-10-23_05-37.jpg');
    expect(storyFileName('@ege', at, 'video/mp4')).toBe('story_@ege_2026-10-23_05-37.mp4');
    expect(storyFileName(null, at, 'image/jpeg')).toBe('story_@unknown_2026-10-23_05-37.jpg');
    expect(storyFileName('ege', at, null)).toBe('story_@unknown_2026-10-23_05-37.bin'.replace('unknown', 'ege'));
  });

  it('cannot put a path or a header break into the name', () => {
    const at = Date.UTC(2026, 9, 23, 5, 37, 12);
    const name = storyFileName('../../etc/pa"ss\r\nword', at, 'image/png');
    expect(name).toBe('story_@....etcpassword_2026-10-23_05-37.png');
    expect(name).not.toMatch(/[\\/"\r\n]/);
  });

  it('keeps two stories of the same author apart in one ZIP', () => {
    const a = storyFileName('ege', Date.UTC(2026, 9, 23, 5, 37), 'image/jpeg');
    const b = storyFileName('ege', Date.UTC(2026, 9, 23, 5, 37), 'image/jpeg');
    expect(uniqueNames([a, b])).toEqual([a, 'story_@ege_2026-10-23_05-37 (2).jpg']);
  });
});
