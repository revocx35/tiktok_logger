import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSummary, FeedComment, FeedItem } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, ErrorNote, Modal, Spinner } from '../components/ui';
import { formatCount } from '../lib/format';

/** How many videos ahead of the one on screen are fetched (and preloaded) at a time. */
const WINDOW = 3;
/** Slides this close to the active one get their video source attached, so a swipe starts playing at once. */
const NEAR = 1;

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
  const [muted, setMuted] = useState(true);
  const [commentsFor, setCommentsFor] = useState<FeedItem | null>(null);
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [shareFor, setShareFor] = useState<FeedItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      return merged.slice(0, 40);
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

  const step = useCallback((dir: 'next' | 'prev') => {
    const el = scroller.current;
    if (!el) return;
    const h = el.clientHeight;
    el.scrollBy({ top: dir === 'next' ? h : -h, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        step('next');
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        step('prev');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const like = async (item: FeedItem) => {
    const want = !item.liked;
    setItems((old) =>
      old.map((i) =>
        i.id === item.id ? { ...i, liked: want, stats: { ...i.stats, likes: i.stats.likes === null ? null : i.stats.likes + (want ? 1 : -1) } } : i,
      ),
    );
    try {
      const r = await api.feedLike(item.id, want);
      setItems((old) => old.map((i) => (i.id === item.id ? { ...i, liked: r.liked } : i)));
    } catch (e) {
      setItems((old) => old.map((i) => (i.id === item.id ? { ...i, liked: !want } : i)));
      setError(errorMessage(e));
    }
  };

  const loadComments = async (item: FeedItem) => {
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const r = await api.feedComments(item.id);
      setComments(r.comments);
    } catch (e) {
      setCommentsError(errorMessage(e));
    } finally {
      setCommentsLoading(false);
    }
  };

  const openComments = (item: FeedItem) => {
    setCommentsFor(item);
    setComments(null);
    void loadComments(item);
  };

  const closeComments = () => {
    setCommentsFor(null);
    setComments(null);
    setCommentsError(null);
    setCommentText('');
    void api.feedCloseComments().catch(() => undefined);
  };

  const postComment = async () => {
    if (!commentsFor || !commentText.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.feedComment(commentsFor.id, commentText.trim());
      setComments(r.comments);
      setCommentText('');
      setNotice('Comment posted.');
    } catch (e) {
      setCommentsError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  /** Sharing runs in the background: the menu closes at once and the result shows up as a note when TikTok has answered. */
  const shareTo = (item: FeedItem, chat: ChatSummary) => {
    setShareFor(null);
    setNotice(`Sending to ${chat.name}…`);
    api.sendText(chat.id, item.url).then(
      () => setNotice(`Sent to ${chat.name}.`),
      (e) => {
        setNotice(null);
        setError(`Could not send to ${chat.name}: ${errorMessage(e)}`);
      },
    );
  };

  const activeIndex = Math.max(0, items.findIndex((i) => i.id === activeId));

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
        </div>
      ) : (
        <div className="feed-window" ref={scroller}>
          {items.map((item, i) => (
            <Slide
              key={item.id}
              item={item}
              active={item.id === activeId}
              near={Math.abs(i - activeIndex) <= NEAR}
              muted={muted}
              onVisible={(id) => {
                setActiveId(id);
                void sync(id);
              }}
              onLike={() => void like(item)}
              onComments={() => openComments(item)}
              onShare={() => setShareFor(item)}
              onToggleMute={() => setMuted((m) => !m)}
            />
          ))}
        </div>
      )}

      <div className="feed-nav">
        <button className="feed-arrow" onClick={() => step('prev')} title="Previous (↑)">
          <Icon name="back" size={22} />
        </button>
        <button className="feed-arrow" onClick={() => step('next')} title="Next (↓)">
          <Icon name="back" size={22} className="flip" />
        </button>
      </div>
      {busy ? (
        <div className="feed-busy">
          <Spinner size={22} />
        </div>
      ) : null}

      {commentsFor ? (
        <CommentsPanel
          comments={comments}
          loading={commentsLoading}
          error={commentsError}
          onRetry={() => void loadComments(commentsFor)}
          text={commentText}
          setText={setCommentText}
          onPost={() => void postComment()}
          onClose={closeComments}
          busy={sending}
        />
      ) : null}
      {shareFor ? (
        <ShareDialog item={shareFor} onClose={() => setShareFor(null)} onPick={(chat) => shareTo(shareFor, chat)} />
      ) : null}

      <div className="feed-errors">
        <ErrorNote error={error} />
        {notice ? (
          <p className="ok-note" onAnimationEnd={() => setNotice(null)}>
            {notice}
          </p>
        ) : null}
      </div>
      <p className="feed-hint muted small">↑ / ↓ or J / K to move · swipe on a phone · click the video to mute</p>
    </div>
  );
}

function Slide({
  item,
  active,
  near,
  muted,
  onVisible,
  onLike,
  onComments,
  onShare,
  onToggleMute,
}: {
  item: FeedItem;
  active: boolean;
  near: boolean;
  muted: boolean;
  onVisible: (id: string) => void;
  onLike: () => void;
  onComments: () => void;
  onShare: () => void;
  onToggleMute: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e && e.isIntersecting && e.intersectionRatio >= 0.6) onVisible(item.id);
      },
      { threshold: [0.6] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [item.id, onVisible]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (active) {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [active, reloadKey, near]);

  useEffect(() => {
    setReady(false);
    setFailed(false);
  }, [item.id, reloadKey]);

  const src = near ? item.video?.src ?? undefined : undefined;

  return (
    <div className="feed-slide" ref={box}>
      {item.video?.poster ? <img className="feed-poster" src={item.video.poster} alt="" aria-hidden="true" /> : null}
      <video
        key={`${item.id}:${reloadKey}`}
        ref={video}
        className={ready ? 'feed-video ready' : 'feed-video'}
        src={src}
        poster={item.video?.poster ?? undefined}
        autoPlay={active}
        loop
        playsInline
        preload={near ? 'auto' : 'none'}
        muted={muted}
        onCanPlay={() => setReady(true)}
        onPlaying={() => setReady(true)}
        onError={() => setFailed(true)}
        onClick={onToggleMute}
      />
      {item.video?.src && !ready && !failed ? (
        <div className="feed-video-loading">
          <Spinner size={26} />
        </div>
      ) : null}
      {!item.video?.src || failed ? (
        <div className="feed-no-video">
          <Icon name="video" size={36} />
          <p>{failed ? 'The video could not be played.' : 'This video is not ready yet — swipe on and come back.'}</p>
          <div className="feed-no-video-actions">
            <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>
              Play again
            </button>
          </div>
        </div>
      ) : null}

      <div className="feed-overlay">
        <div className="feed-meta">
          {item.author.username ? (
            <a className="feed-author" href={item.url} target="_blank" rel="noopener noreferrer">
              @{item.author.username}
            </a>
          ) : null}
          {item.caption ? <p className="feed-caption">{item.caption}</p> : null}
          {item.music ? (
            <p className="feed-music">
              <Icon name="music" size={14} /> {item.music}
            </p>
          ) : null}
          <p className="feed-stats">
            {formatCount(item.stats.plays)} plays · {formatCount(item.stats.likes)} likes · {formatCount(item.stats.comments)} comments
          </p>
        </div>

        <div className="feed-rail">
          <button className={item.liked ? 'feed-act liked' : 'feed-act'} onClick={onLike} title={item.liked ? 'Unlike' : 'Like'} aria-pressed={item.liked}>
            <Icon name="heart" size={28} />
            <span>{formatCount(item.stats.likes)}</span>
          </button>
          <button className="feed-act" onClick={onComments} title="Comments">
            <Icon name="comment" size={26} />
            <span>{formatCount(item.stats.comments)}</span>
          </button>
          <button className="feed-act" onClick={onShare} title="Send to a chat">
            <Icon name="send" size={24} />
            <span>Send</span>
          </button>
          <button className="feed-act" onClick={onToggleMute} title={muted ? 'Unmute' : 'Mute'}>
            <Icon name={muted ? 'mute' : 'volume'} size={24} />
            <span>{muted ? 'Sound off' : 'Sound on'}</span>
          </button>
          <a className="feed-act" href={item.url} target="_blank" rel="noopener noreferrer" title="Open on TikTok">
            <Icon name="link" size={22} />
            <span>TikTok</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function CommentsPanel({
  comments,
  loading,
  error,
  onRetry,
  text,
  setText,
  onPost,
  onClose,
  busy,
}: {
  comments: FeedComment[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  text: string;
  setText: (v: string) => void;
  onPost: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    <aside className="feed-comments" aria-label="Comments">
      <header>
        <strong>
          {loading ? 'Loading comments…' : comments && comments.length > 0 ? (comments.length === 1 ? '1 comment' : `${comments.length} comments`) : 'Comments'}
        </strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="feed-comment-list">
        {loading ? (
          <div className="feed-comments-state">
            <Spinner size={22} />
            <p className="muted small">Opening the comment panel in TikTok…</p>
          </div>
        ) : null}
        {error && !loading ? (
          <div className="feed-comments-state">
            <p className="small">{error}</p>
            <button className="btn" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
        {!loading && !error && comments && comments.length === 0 ? <p className="muted small">No comments on this video yet.</p> : null}
        {(comments ?? []).map((c) => (
          <CommentRow key={c.id} c={c} depth={0} />
        ))}
      </div>
      <div className="feed-comment-form">
        <input
          type="text"
          maxLength={150}
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onPost();
          }}
        />
        <button className="btn" onClick={onPost} disabled={busy || !text.trim()}>
          Post
        </button>
      </div>
    </aside>
  );
}

function CommentRow({ c, depth }: { c: FeedComment; depth: number }) {
  return (
    <div className={`feed-comment depth-${Math.min(depth, 2)}`}>
      <div className="feed-comment-head">
        <strong>{c.author.username ? `@${c.author.username}` : c.author.name ?? 'Someone'}</strong>
        {c.likes ? <span className="muted small">♥ {formatCount(c.likes)}</span> : null}
      </div>
      <p>{c.text}</p>
      {c.replies.map((r) => (
        <CommentRow key={r.id} c={r} depth={depth + 1} />
      ))}
    </div>
  );
}

function ShareDialog({ item, onClose, onPick }: { item: FeedItem; onClose: () => void; onPick: (chat: ChatSummary) => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.chats().then((all) => setChats(all.filter((c) => !c.removed)), (e) => setError(errorMessage(e)));
  }, []);

  return (
    <Modal title="Send this video" onClose={onClose}>
      <p className="muted small">The link opens on TikTok: {item.url}</p>
      <div className="feed-chat-picker">
        {chats === null && !error ? <Spinner size={20} /> : null}
        {(chats ?? []).map((c) => (
          <button key={c.id} className="feed-chat-row" onClick={() => onPick(c)}>
            <Avatar id={c.id} name={c.name} url={c.avatarUrl ?? null} kind={c.kind} size={36} />
            <span className="feed-chat-name">{c.name}</span>
            <Icon name="send" size={16} />
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
