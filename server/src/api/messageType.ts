import type { MessageType, ShareInfo } from '../../../shared/api.js';

/**
 * Two normalisations the API needs because TikTok's own names leak into the database.
 *
 * `messages.type` holds what TikTok called the message (`shared_post`, `media`, `unsupported`, …), which is not what
 * `shared/api.d.ts` promises. Every shared TikTok video in the owner's log is stored as `shared_post` — 1 873 rows on
 * 2026-10-23 — so a cast (`row.type as MessageType`) made the web UI fall through its render switch and the video was
 * invisible: no card, no player, nothing to click. These are pure functions so the mapping is testable without a repo.
 */

const API_TYPES = new Set<MessageType>(['text', 'image', 'video', 'voice', 'sticker', 'share', 'system', 'unknown']);

/** The stored type → the API's `MessageType` ([mime] comes from the stored media, used for TikTok's generic `media`). */
export function apiType(stored: string, mime?: string | null): MessageType {
  if (stored === 'shared_post') return 'share';
  if (stored === 'unsupported') return 'unknown';
  if (stored === 'media') {
    const m = (mime ?? '').toLowerCase();
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'voice';
    if (m.startsWith('image/')) return 'image';
    // No mime yet (still downloading): the protocol uses `media` for photos and videos alike.
    return 'image';
  }
  return API_TYPES.has(stored as MessageType) ? (stored as MessageType) : 'unknown';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The post id in a tiktok.com link (`/@user/video/<id>`, `/v/<id>`), so an older row with only a URL still gets a card. */
export function videoIdOf(url: string | null): string | null {
  const m = url ? /\/(?:video|v)\/(\d{6,24})(?!\d)/.exec(url) : null;
  return m ? m[1]! : null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The card shown for a shared post: TikTok's own card fields when the capture kept them, else what the IM content gave
 * us (`itemId`, the canonical URL, the post title as the message body).
 */
export function shareInfo(type: MessageType, text: string | null, meta: unknown): ShareInfo | null {
  const m = obj(meta);
  const given = Object.keys(obj(m.share)).length ? obj(m.share) : null;
  if (type !== 'share' && !given) return null;
  const url = str(given?.url) ?? str(m.url);
  const itemId = str(given?.itemId) ?? str(m.itemId) ?? videoIdOf(url);
  const href = url ?? (itemId ? `https://www.tiktok.com/@_/video/${itemId}` : null);
  return {
    kind: str(given?.kind) ?? (itemId ? 'Video' : 'Link'),
    title: str(given?.title) ?? text ?? str(m.shareTitle),
    subtitle: str(given?.subtitle),
    caption: str(given?.caption),
    url: href,
    eyebrow: str(given?.eyebrow),
    itemId,
  };
}
