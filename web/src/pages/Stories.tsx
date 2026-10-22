import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StoryAccount, StoryAuthor, StoryItem, StoryStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, EmptyState, ErrorNote, Spinner } from '../components/ui';

/**
 * Logged stories, the way insta_logger shows them: a row of the accounts whose stories were captured, and a grid of
 * the stories themselves. Clicking one opens the viewer (videos play, photos hold for a few seconds and move on).
 *
 * The capture itself runs in the background on the server (tt/stories.ts); this page only reads what was stored and
 * offers "Check now".
 */
export function StoriesPage() {
  const [status, setStatus] = useState<StoryStatus | null>(null);
  const [authors, setAuthors] = useState<StoryAuthor[]>([]);
  const [items, setItems] = useState<StoryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [author, setAuthor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

  const load = useCallback(
    async (who: string | null, before: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const [st, au, page] = await Promise.all([api.storiesStatus(), api.storiesAuthors(), api.stories({ user: who ?? undefined, before, limit: 60 })]);
        setStatus(st);
        setAuthors(au);
        setItems((old) => (before ? [...old, ...page.items] : page.items));
        setNextBefore(page.nextBefore);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(author, null);
  }, [author, load]);

  const check = async () => {
    setBusy(true);
    try {
      const st = await api.storiesCheck();
      setStatus(st);
      setError(st.lastResult && !st.lastResult.includes('author') ? st.lastResult : null);
      await load(author, null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const chosen = useMemo(() => (author ? authors.find((a) => a.id === author) ?? null : null), [author, authors]);

  if (!loading && status && !status.logging && !items.length) {
    return (
      <div className="page">
        <EmptyState icon="stories" title="Story logging is off">
          Turn it on in <b>Settings → Stories</b> to keep the stories of the accounts you follow (photos and videos, 24
          hours each) before they disappear. Nothing is marked as seen.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page stories-page">
      <header className="page-head">
        <div>
          <h1>Stories</h1>
          <p className="muted small">
            {status ? (
              <>
                {status.items} stor{status.items === 1 ? 'y' : 'ies'} from {status.authors} account{status.authors === 1 ? '' : 's'}
                {status.pending ? ` · ${status.pending} still downloading` : ''}
                {status.lastCheckAt ? ` · last check ${when(status.lastCheckAt)}` : ''}
                {status.nextCheckAt ? ` · next ${when(status.nextCheckAt)}` : ''}
              </>
            ) : (
              'Loading…'
            )}
          </p>
        </div>
        <div className="page-actions">
          {author ? (
            <button className="btn ghost" onClick={() => setAuthor(null)}>
              All accounts
            </button>
          ) : null}
          <button className="btn" onClick={() => void check()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="refresh" size={16} />} Check now
          </button>
        </div>
      </header>

      <ErrorNote error={error} />

      <div className="story-authors">
        {authors.map((a) => (
          <button
            key={a.id}
            className={author === a.id ? 'story-author active' : 'story-author'}
            onClick={() => setAuthor(author === a.id ? null : a.id)}
            title={a.username ? `@${a.username}` : a.id}
          >
            <span className="story-ring">
              {a.avatarUrl ? <img src={a.avatarUrl} alt="" loading="lazy" /> : <span className="story-initial">{(a.username ?? '?').slice(0, 1).toUpperCase()}</span>}
            </span>
            <span className="story-author-name">@{a.username ?? a.id.slice(-6)}</span>
            <span className="muted small">{a.count}</span>
          </button>
        ))}
        {!authors.length && !loading ? <p className="muted small">No stories logged yet. “Check now” reads TikTok&rsquo;s stories bar.</p> : null}
      </div>

      {items.length ? (
        <div className="story-grid">
          {items.map((s, i) => (
            <button key={s.id} className="story-tile" onClick={() => setViewer(i)} title={s.username ? `@${s.username}` : s.id}>
              {s.type === 'video' ? (
                s.url ? (
                  <video src={s.url} muted playsInline preload="metadata" />
                ) : (
                  <span className="story-tile-pending">
                    <Spinner size={18} />
                  </span>
                )
              ) : s.url ? (
                <img src={s.url} alt="" loading="lazy" />
              ) : (
                <span className="story-tile-pending">
                  <Spinner size={18} />
                </span>
              )}
              <span className="story-tile-meta">
                <b>@{s.username ?? s.userId.slice(-6)}</b>
                <span>{when(s.takenAt)}</span>
              </span>
              {s.status !== 'downloaded' ? <span className="story-tile-badge">{s.status === 'pending' ? 'downloading' : s.status}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {!loading && !items.length && authors.length ? <p className="muted small">No stories for {chosen ? `@${chosen.username ?? chosen.id}` : 'this account'} in the log.</p> : null}

      {nextBefore ? (
        <div className="page-more">
          <button className="btn ghost" onClick={() => void load(author, nextBefore)} disabled={loading}>
            {loading ? <Spinner size={16} /> : null} Load older
          </button>
        </div>
      ) : null}

      {viewer !== null && items[viewer] ? <StoryViewer items={items} start={viewer} onClose={() => setViewer(null)} /> : null}
    </div>
  );
}

/** Full-screen story viewer: videos play, photos hold, ← / → (or a click on the side) move between them. */
function StoryViewer({ items, start, onClose }: { items: StoryItem[]; start: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const video = useRef<HTMLVideoElement | null>(null);
  const story = items[at];

  const next = useCallback(() => setAt((i) => (i + 1 < items.length ? i + 1 : i)), [items.length]);
  const prev = useCallback(() => setAt((i) => (i > 0 ? i - 1 : 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  // A photo has no end event: hold it for a few seconds like a story does.
  useEffect(() => {
    if (!story || story.type !== 'image') return;
    const t = setTimeout(next, 5000);
    return () => clearTimeout(t);
  }, [story, next]);

  if (!story) return null;
  return (
    <div className="story-viewer" role="dialog" aria-modal="true">
      <button className="story-viewer-close" onClick={onClose} title="Close">
        <Icon name="close" size={22} />
      </button>
      <button className="story-viewer-side left" onClick={prev} aria-label="Previous" />
      <div className="story-viewer-body">
        <div className="story-viewer-head">
          <b>@{story.username ?? story.userId.slice(-6)}</b>
          <span className="muted small">{when(story.takenAt)}</span>
        </div>
        {story.type === 'video' && story.url ? (
          <video ref={video} key={story.id} src={story.url} autoPlay playsInline controls onEnded={next} />
        ) : story.url ? (
          <img key={story.id} src={story.url} alt="" />
        ) : (
          <div className="story-viewer-missing">
            <Spinner size={22} />
            <p className="muted small">Still downloading…</p>
          </div>
        )}
        <div className="story-viewer-foot muted small">
          {at + 1} / {items.length}
          {story.expiresAt ? ` · expired on TikTok ${when(story.expiresAt)}` : ''}
        </div>
      </div>
      <button className="story-viewer-side right" onClick={next} aria-label="Next" />
    </div>
  );
}

function when(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins >= 0 && mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
