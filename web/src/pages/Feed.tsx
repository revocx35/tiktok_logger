import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ErrorNote, Spinner } from '../components/ui';
import { VideoStack } from '../components/VideoStack';

/** How many videos ahead of the one on screen are fetched (and preloaded) at a time. */
const WINDOW = 4;

/**
 * TikTok's For You feed inside tiktok_logger.
 *
 * The videos come through the server (never from TikTok's CDN, so the signed links stay there) and are cached there.
 * The swiping is a native snapping scroller — the same thing insta_logger's Reels use — which is what gives the
 * momentum and the snap animation on a phone and the wheel/keyboard behaviour on a desktop. The remote TikTok page is
 * moved to whatever slide the user settles on, so likes and comments always act on the video in view.
 */
export function FeedPage() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** The video the remote page is on, so a goto is only sent when the user really moved. */
  const serverId = useRef<string | null>(null);
  const gotoSeq = useRef(0);
  const itemsRef = useRef<FeedItem[]>([]);
  itemsRef.current = items;

  /** Puts a fresh window into the list without disturbing what is already rendered above. */
  const apply = useCallback((r: { items: FeedItem[]; current: string | null }) => {
    if (r.current) serverId.current = r.current;
    setItems((old) => {
      const merged = old.slice();
      for (const it of r.items) {
        const at = merged.findIndex((o) => o.id === it.id);
        if (at >= 0) merged[at] = { ...merged[at]!, ...it };
        else merged.push(it);
      }
      // Only new videos are appended, so nothing above the one in view moves, and nothing is cut off: a slide away
      // from the one in view has no video source (a poster and a few nodes). A cap of 40 used to end the feed there.
      return merged;
    });
    setActiveId((cur) => cur ?? r.current ?? r.items[0]?.id ?? null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.feedWindow(WINDOW);
      setItems(r.items);
      setActiveId(r.current ?? r.items[0]?.id ?? null);
      serverId.current = r.current;
      setError(null);
      scroller.current?.scrollTo({ top: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** The user settled on a slide: move the remote page there and pull the next videos in. */
  const sync = useCallback(
    async (id: string) => {
      if (!id || id === serverId.current) return;
      const seq = ++gotoSeq.current;
      setBusy(true);
      try {
        const r = await api.feedGoto(id);
        if (seq !== gotoSeq.current) return;
        apply(r);
        setError(null);
      } catch (e) {
        if (seq === gotoSeq.current) setError(errorMessage(e));
      } finally {
        if (seq === gotoSeq.current) setBusy(false);
      }
    },
    [apply],
  );

  const onActive = useCallback(
    (id: string) => {
      setActiveId(id);
      void sync(id);
    },
    [sync],
  );

  return (
    <div className="feed">
      {loading && !items.length ? (
        <div className="feed-loading">
          <Spinner size={34} />
          <p>Opening the feed in the server's browser…</p>
        </div>
      ) : !items.length ? (
        <div className="feed-loading">
          <Icon name="video" size={36} />
          <p>No video could be read from the feed.</p>
          <button className="btn" onClick={() => void load()}>
            Try again
          </button>
          <ErrorNote error={error} />
        </div>
      ) : (
        <VideoStack
          items={items}
          setItems={setItems}
          activeId={activeId}
          scroller={scroller}
          error={error}
          onActive={onActive}
        />
      )}
      {/* Only at the end of the list: elsewhere the next videos are already there, so a spinner over them is noise. */}
      {busy && activeId !== null && items.findIndex((i) => i.id === activeId) >= items.length - 1 ? (
        <div className="feed-busy">
          <Spinner size={22} />
        </div>
      ) : null}
    </div>
  );
}
