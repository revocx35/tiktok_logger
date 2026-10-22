import { useEffect, useRef, useState } from 'react';
import type { TtItem } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { safeHref } from '../lib/ttText';
import { Icon } from './Icon';
import { Spinner } from './ui';

/**
 * A TikTok post inside a chat, as a card you can play.
 *
 * Two things end up here: a shared post that TikTok stored as a card (`share.itemId`, what the official client sends)
 * and the canonical link our own share falls back to when TikTok drops the card. Both showed as a bare link before,
 * which is how a shared video looked like "just a link" in the chat.
 *
 * The post itself is resolved by the server through the logged-in tab (`GET /api/items/:id`); the video and the cover
 * come from the server's own ranged routes, so the signed TikTok CDN link never reaches the browser and the video plays
 * on a phone (it needs ranges).
 */
/**
 * One request per post per session: a chat can show the same shared video many times, and every miss is a request to
 * TikTok through the tab (the server caches too, but this keeps the tab quiet).
 */
const seen = new Map<string, Promise<TtItem>>();
const SEEN_TTL_MS = 5 * 60_000;

function resolveItem(id: string): Promise<TtItem> {
  const hit = seen.get(id);
  if (hit) return hit;
  const p = api.item(id);
  seen.set(id, p);
  // A failure is not cached: the next card may be opened after the connection came back.
  p.catch(() => seen.delete(id));
  setTimeout(() => seen.delete(id), SEEN_TTL_MS);
  return p;
}

export function TikTokCard({
  itemId,
  url,
  title,
  caption,
}: {
  itemId: string;
  /** Where to go when the card cannot be resolved (TikTok's own page). */
  url?: string | null;
  /** What the message said about the post (the card title when TikTok gave none). */
  title?: string | null;
  caption?: string | null;
}) {
  const [item, setItem] = useState<TtItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Only what the owner scrolls to is resolved: a chat can hold hundreds of shared videos, and each one is a request to
  // TikTok through the tab.
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setItem(null);
    setError(null);
    setPlaying(false);
    resolveItem(itemId).then(
      (it) => alive && setItem(it),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [itemId, visible]);

  const href = safeHref(item?.url ?? url ?? `https://www.tiktok.com/@_/video/${itemId}`);
  const text = item?.desc ?? title ?? null;

  const open = href ? (
    <a className="tt-card-open" href={href} target="_blank" rel="noopener noreferrer nofollow" title="Open on TikTok">
      <Icon name="forward" size={14} /> TikTok
    </a>
  ) : null;

  if (playing && item?.videoUrl) {
    return (
      <div className="tt-card playing">
        <video
          className="tt-card-video"
          src={item.videoUrl}
          poster={item.coverUrl ?? undefined}
          controls
          autoPlay
          playsInline
          onError={() => {
            // The server could not fetch it (post gone, CDN refused): fall back to the poster and the link.
            setPlaying(false);
            setError('That video could not be loaded. Open it on TikTok.');
          }}
        />
        <div className="tt-card-foot">
          <span className="tt-card-author">@{item.author.username ?? 'tiktok'}</span>
          {open}
        </div>
      </div>
    );
  }

  // Browser button over the poster: a real <button> (not a div with a click handler) so it is focusable and Enter works.
  const poster = item?.coverUrl ? (
    <button
      type="button"
      className="tt-card-poster"
      onClick={() => (item.videoUrl ? setPlaying(true) : window.open(href ?? undefined, '_blank', 'noopener'))}
      aria-label={item.videoUrl ? 'Play video' : 'Open on TikTok'}
      title={item.videoUrl ? 'Play' : 'Open on TikTok'}
    >
      <img src={item.coverUrl} alt="" loading="lazy" decoding="async" />
      <span className={item.videoUrl ? 'tt-card-play' : 'tt-card-play open'} aria-hidden="true" />
      {item.durationSec ? <span className="tt-card-time">{formatDuration(item.durationSec)}</span> : null}
    </button>
  ) : null;

  return (
    <div className={item || error ? 'tt-card' : 'tt-card loading'} ref={ref}>
      {poster}
      <div className="tt-card-info">
        <div className="tt-card-head">
          <Icon name="video" size={14} />
          <span className="tt-card-author">@{item?.author.username ?? 'tiktok'}</span>
          {open}
        </div>
        {text ? <div className="tt-card-desc">{text}</div> : caption ? <div className="tt-card-desc">{caption}</div> : null}
        {!item && !error ? (
          <div className="tt-card-loading">
            <Spinner size={14} /> Loading the video…
          </div>
        ) : null}
        {error ? <div className="tt-card-error muted small">{error}</div> : null}
        {item?.stats.likes !== null && item?.stats.likes !== undefined ? (
          <div className="tt-card-stats muted small">
            {compact(item.stats.likes)} likes{item.stats.plays ? ` · ${compact(item.stats.plays)} plays` : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.0', '')}K`;
  return String(n);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
