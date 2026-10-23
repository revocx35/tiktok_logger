import type { StoryItem } from '../../../shared/api';

/**
 * Download links for logged stories.
 *
 * A story is served by the ordinary media route (`/api/media/<id>`, decrypted on the fly), and `?download=1` makes it
 * an attachment with a name built from the author and the story's time (`story_@user_2026-10-23_05-37.jpg`) — see
 * `storyFileName()` and `attachment` against `inline` in `server/src/api/media.ts`.
 *
 * Kept out of the page component so it can be tested without a DOM.
 */

/** `href` for one story's file, or null while it is still downloading. */
export function storyDownloadUrl(item: Pick<StoryItem, 'url'>): string | null {
  if (!item.url) return null;
  return item.url.includes('?') ? `${item.url}&download=1` : `${item.url}?download=1`;
}

/** The `ids` value for `/api/media-zip` (every downloaded story in the list), or null when there is nothing to zip. */
export function storyZipIds(items: Pick<StoryItem, 'mediaId'>[]): string | null {
  const ids = items.map((i) => i.mediaId).filter((id): id is number => typeof id === 'number' && id > 0);
  if (!ids.length) return null;
  return [...new Set(ids)].join(',');
}
