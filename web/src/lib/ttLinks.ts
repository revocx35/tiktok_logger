/**
 * TikTok links inside message text.
 *
 * A shared video that TikTok refused to store as a card arrives as its canonical link (the send falls back to text —
 * see tt/im/engine.ts), and people paste links by hand. Both should render as a playable card instead of a bare URL,
 * so the id has to be found in whatever text TikTok gave us.
 *
 * Shapes that carry an id: `https://www.tiktok.com/@user/video/<id>`, `…/@_/video/<id>?lang=en`, `https://m.tiktok.com/v/<id>.html`.
 * A short link (`https://vm.tiktok.com/ZM…/`) does not — it has to be followed, which the app will not do, so it stays a
 * plain link.
 */
const LINK = /https?:\/\/(?:www\.|m\.)?tiktok\.com\/(?:@[^/\s]*\/video|v)\/(\d{6,24})(?!\d)/i;

/** The first TikTok video link in [text]: the id and the URL as it was written. */
export function findTiktokVideo(text: string | null | undefined): { id: string; url: string } | null {
  const m = text ? LINK.exec(text) : null;
  if (!m || m.index === undefined) return null;
  // The whole URL as written (the id match stops at the digits; the query string is part of the link).
  const url = /^https?:\/\/\S+/.exec(text!.slice(m.index))?.[0] ?? m[0];
  return { id: m[1]!, url };
}

/** The post id in the first TikTok video link of [text]. */
export function tiktokVideoId(text: string | null | undefined): string | null {
  return findTiktokVideo(text)?.id ?? null;
}

/** True when the text is nothing but that link (so the card can replace it instead of repeating it). */
export function isOnlyLink(text: string | null | undefined, url: string | null | undefined): boolean {
  if (!text || !url) return false;
  return text.trim() === url.trim();
}
