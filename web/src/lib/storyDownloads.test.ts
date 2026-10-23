import { describe, expect, it } from 'vitest';
import { storyDownloadUrl, storyZipIds } from './storyDownloads';

/**
 * Story downloads: each item is its media route with `?download=1` (the server answers `Content-Disposition: attachment`
 * and names the file `story_@user_<date>.<ext>`), and "Download all" feeds the ordinary ZIP route the media ids.
 */
describe('story downloads', () => {
  it('adds the attachment flag to the media url and nothing when there is no file yet', () => {
    expect(storyDownloadUrl({ url: '/api/media/42' })).toBe('/api/media/42?download=1');
    expect(storyDownloadUrl({ url: '/api/media/42?x=1' })).toBe('/api/media/42?x=1&download=1');
    expect(storyDownloadUrl({ url: null })).toBeNull();
  });

  it('collects the media ids for a ZIP, once each, and nothing when no story is downloaded', () => {
    expect(storyZipIds([{ mediaId: 7 }, { mediaId: 7 }, { mediaId: 8 }, { mediaId: null }])).toBe('7,8');
    expect(storyZipIds([{ mediaId: null }, { mediaId: null }])).toBeNull();
    expect(storyZipIds([])).toBeNull();
  });
});
