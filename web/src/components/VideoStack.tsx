import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { Link } from 'react-router';
import type { ChatSummary, FeedComment, FeedItem } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { formatCount } from '../lib/format';
import { Icon } from './Icon';
import { Avatar, ErrorNote, Modal, Spinner } from './ui';

/** Slides this close to the active one get their video source attached (and buffer), so a swipe starts playing at once:
 *  one behind, two ahead — the way people swipe. */
const BEHIND = 1;
const AHEAD = 2;
/** TikTok's own speed steps. */
const SPEEDS = [1, 1.5, 2, 0.5, 0.75];

/**
 * The swiping video player shared by the For You page and a profile's videos (v1.15).
 *
 * A native snapping scroller (momentum and snap on a phone, wheel/keyboard on a desktop) with TikTok's action column —
 * the author (opens their profile here, with a follow badge), like, comments, repost, send to a chat, download — and a
 * player row: play/pause, a seek bar, speed and TikTok's own captions. Every action goes to the server, which does it
 * as the logged-in account; the list is updated with what TikTok answered, not with what was asked.
 */
export function VideoStack({
  items,
  setItems,
  activeId,
  onActive,
  scroller,
  startAt,
  error,
  header,
  hint,
}: {
  items: FeedItem[];
  setItems: Dispatch<SetStateAction<FeedItem[]>>;
  activeId: string | null;
  onActive: (id: string) => void;
  scroller: RefObject<HTMLDivElement | null>;
  /** Scrolls to this video once on mount (a profile opens the video that was tapped). */
  startAt?: string | null;
  /** An error from the page around the stack (the feed's own loading), shown with the stack's own. */
  error?: string | null;
  header?: ReactNode;
  hint?: ReactNode;
}) {
  const [ownError, setOwnError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [captions, setCaptions] = useState(false);
  const [commentsFor, setCommentsFor] = useState<FeedItem | null>(null);
  const [shareFor, setShareFor] = useState<FeedItem | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const patch = useCallback((id: string, fn: (i: FeedItem) => FeedItem) => setItems((old) => old.map((i) => (i.id === id ? fn(i) : i))), [setItems]);
  const patchAuthor = useCallback(
    (username: string, following: boolean) => setItems((old) => old.map((i) => (i.author.username === username ? { ...i, author: { ...i.author, following } } : i))),
    [setItems],
  );

  useEffect(() => {
    if (!startAt) return;
    const at = items.findIndex((i) => i.id === startAt);
    const el = scroller.current;
    if (at >= 0 && el) el.scrollTo({ top: at * el.clientHeight });
    // Once, for the video that was tapped; later list changes must not jump back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startAt]);

  const step = useCallback(
    (dir: 'next' | 'prev') => {
      const el = scroller.current;
      if (!el) return;
      const h = el.clientHeight;
      el.scrollBy({ top: dir === 'next' ? h : -h, behavior: 'smooth' });
    },
    [scroller],
  );

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
      } else if (e.key === 'm') {
        setMuted((m) => !m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const flag = (key: string, on: boolean) => setBusy((b) => ({ ...b, [key]: on }));

  const like = async (item: FeedItem) => {
    const want = !item.liked;
    patch(item.id, (i) => ({ ...i, liked: want, stats: { ...i.stats, likes: i.stats.likes === null ? null : i.stats.likes + (want ? 1 : -1) } }));
    try {
      const r = await api.feedLike(item.id, want);
      patch(item.id, (i) => ({ ...i, liked: r.liked }));
    } catch (e) {
      patch(item.id, (i) => ({ ...i, liked: !want, stats: { ...i.stats, likes: item.stats.likes } }));
      setOwnError(errorMessage(e));
    }
  };

  const repost = async (item: FeedItem) => {
    const key = `repost:${item.id}`;
    if (busy[key]) return;
    const want = !item.reposted;
    flag(key, true);
    setNotice(want ? 'Reposting…' : 'Removing the repost…');
    try {
      const r = await api.feedRepost(item.id, want);
      patch(item.id, (i) => ({ ...i, reposted: r.reposted }));
      setNotice(r.reposted ? 'Reposted to your followers.' : 'Repost removed.');
    } catch (e) {
      setNotice(null);
      setOwnError(errorMessage(e));
    } finally {
      flag(key, false);
    }
  };

  const follow = async (item: FeedItem) => {
    const u = item.author.username;
    if (!u) return;
    const key = `follow:${u}`;
    if (busy[key]) return;
    const want = !item.author.following;
    flag(key, true);
    patchAuthor(u, want);
    try {
      const r = await api.follow(u, want);
      patchAuthor(u, r.following);
      setNotice(r.following ? `Following @${u}.` : `Unfollowed @${u}.`);
    } catch (e) {
      patchAuthor(u, !want);
      setOwnError(errorMessage(e));
    } finally {
      flag(key, false);
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
        setOwnError(`Could not send to ${chat.name}: ${errorMessage(e)}`);
      },
    );
  };

  const activeIndex = Math.max(0, items.findIndex((i) => i.id === activeId));

  return (
    <>
      {header}
      <div className="feed-window" ref={scroller}>
        {items.map((item, i) => (
          <Slide
            key={item.id}
            item={item}
            active={item.id === activeId}
            near={i - activeIndex >= -BEHIND && i - activeIndex <= AHEAD}
            muted={muted}
            speed={speed}
            captions={captions}
            followBusy={!!busy[`follow:${item.author.username}`]}
            repostBusy={!!busy[`repost:${item.id}`]}
            onVisible={onActive}
            onLike={() => void like(item)}
            onComments={() => setCommentsFor(item)}
            onShare={() => setShareFor(item)}
            onRepost={() => void repost(item)}
            onFollow={() => void follow(item)}
            onToggleMute={() => setMuted((m) => !m)}
            onSpeed={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]!)}
            onCaptions={() => setCaptions((c) => !c)}
          />
        ))}
      </div>

      <div className="feed-nav">
        <button className="feed-arrow" onClick={() => step('prev')} title="Previous (↑)">
          <Icon name="arrowUp" size={22} />
        </button>
        <button className="feed-arrow" onClick={() => step('next')} title="Next (↓)">
          <Icon name="arrowDown" size={22} />
        </button>
      </div>

      {commentsFor ? (
        <CommentsPanel
          item={commentsFor}
          onClose={() => {
            setCommentsFor(null);
            void api.feedCloseComments().catch(() => undefined);
          }}
          onPosted={(what) => setNotice(what)}
        />
      ) : null}
      {shareFor ? <ShareDialog item={shareFor} onClose={() => setShareFor(null)} onPick={(chat) => shareTo(shareFor, chat)} /> : null}

      <div className="feed-errors">
        <ErrorNote error={ownError ?? error ?? null} />
        {notice ? (
          <p className="ok-note" onAnimationEnd={() => setNotice(null)}>
            {notice}
          </p>
        ) : null}
      </div>
      {hint ?? <p className="feed-hint muted small">↑ / ↓ or J / K to move · M to mute · click the video to pause</p>}
    </>
  );
}

function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function Slide({
  item,
  active,
  near,
  muted,
  speed,
  captions,
  followBusy,
  repostBusy,
  onVisible,
  onLike,
  onComments,
  onShare,
  onRepost,
  onFollow,
  onToggleMute,
  onSpeed,
  onCaptions,
}: {
  item: FeedItem;
  active: boolean;
  near: boolean;
  muted: boolean;
  speed: number;
  captions: boolean;
  followBusy: boolean;
  repostBusy: boolean;
  onVisible: (id: string) => void;
  onLike: () => void;
  onComments: () => void;
  onShare: () => void;
  onRepost: () => void;
  onFollow: () => void;
  onToggleMute: () => void;
  onSpeed: () => void;
  onCaptions: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState({ at: 0, len: 0 });
  const seeking = useRef(false);

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
      setPaused(false);
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [active, reloadKey, near]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = speed;
  }, [speed, reloadKey, near]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    for (const t of Array.from(v.textTracks)) t.mode = captions ? 'showing' : 'hidden';
  }, [captions, reloadKey, near, ready]);

  useEffect(() => {
    setReady(false);
    setFailed(false);
    setTime({ at: 0, len: 0 });
  }, [item.id, reloadKey]);

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      void v.play().catch(() => undefined);
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  };

  const src = near ? item.video?.src ?? undefined : undefined;
  const tracks = item.video?.captions ?? [];
  const profile = item.author.username ? `/profile/${encodeURIComponent(item.author.username)}` : null;

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
        onClick={togglePlay}
        onLoadedMetadata={(e) => setTime({ at: 0, len: e.currentTarget.duration })}
        onTimeUpdate={(e) => {
          if (active && !seeking.current) setTime({ at: e.currentTarget.currentTime, len: e.currentTarget.duration });
        }}
      >
        {near ? tracks.map((t, n) => <track key={t.src} kind="subtitles" src={t.src} srcLang={t.lang.slice(0, 2).toLowerCase()} label={t.lang} default={captions && n === 0} />) : null}
      </video>
      {paused && ready ? (
        <button className="feed-paused" onClick={togglePlay} aria-label="Play">
          <Icon name="play" size={56} />
        </button>
      ) : null}
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
          {item.author.username && profile ? (
            <Link className="feed-author" to={profile}>
              {item.author.name || item.author.username}
              {item.author.name && item.author.name !== item.author.username ? <span className="feed-handle">@{item.author.username}</span> : null}
            </Link>
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
          {/* The player row: play/pause, seek, speed and captions (TikTok's own auto-captions when it made them). */}
          <div className="feed-player" onClick={(e) => e.stopPropagation()}>
            <button className="feed-player-btn" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play' : 'Pause'}>
              <Icon name={paused ? 'play' : 'pause'} size={18} />
            </button>
            <input
              className="feed-seek"
              type="range"
              min={0}
              max={time.len || 0}
              step={0.1}
              value={Math.min(time.at, time.len || 0)}
              aria-label="Seek"
              disabled={!time.len}
              onPointerDown={() => (seeking.current = true)}
              onPointerUp={() => (seeking.current = false)}
              onChange={(e) => {
                const v = video.current;
                const to = Number(e.target.value);
                setTime((t) => ({ ...t, at: to }));
                if (v) v.currentTime = to;
              }}
            />
            <span className="feed-time">
              {clock(time.at)} / {clock(time.len)}
            </span>
            <button className="feed-player-btn feed-speed" onClick={onSpeed} title="Playback speed" aria-label={`Playback speed ${speed}×`}>
              {speed}×
            </button>
            {tracks.length ? (
              <button className={captions ? 'feed-player-btn on' : 'feed-player-btn'} onClick={onCaptions} title={captions ? 'Hide captions' : 'Show captions'} aria-pressed={captions}>
                <Icon name="captions" size={18} />
              </button>
            ) : null}
          </div>
        </div>

        {/* TikTok's action column: the author's avatar (with the follow badge), then solid icons with bold counts below. */}
        <div className="feed-rail">
          <div className="feed-avatar-box">
            {profile ? (
              <Link className="feed-avatar" to={profile} title={`@${item.author.username}`}>
                {item.author.avatar ? <img src={item.author.avatar} alt="" /> : <Icon name="userFill" size={26} />}
              </Link>
            ) : (
              <span className="feed-avatar">{item.author.avatar ? <img src={item.author.avatar} alt="" /> : <Icon name="userFill" size={26} />}</span>
            )}
            {item.author.username && item.author.following !== undefined && item.author.following !== null ? (
              <button
                className={item.author.following ? 'feed-follow on' : 'feed-follow'}
                onClick={onFollow}
                disabled={followBusy}
                title={item.author.following ? `Unfollow @${item.author.username}` : `Follow @${item.author.username}`}
                aria-pressed={item.author.following}
              >
                <Icon name={item.author.following ? 'check' : 'plus'} size={14} />
              </button>
            ) : null}
          </div>
          <button className={item.liked ? 'feed-act liked' : 'feed-act'} onClick={onLike} title={item.liked ? 'Unlike' : 'Like'} aria-pressed={item.liked}>
            <span className="feed-act-icon">
              <Icon name="heartFill" size={26} />
            </span>
            <span>{formatCount(item.stats.likes)}</span>
          </button>
          <button className="feed-act" onClick={onComments} title="Comments">
            <span className="feed-act-icon">
              <Icon name="commentFill" size={24} />
            </span>
            <span>{formatCount(item.stats.comments)}</span>
          </button>
          {item.canRepost !== false ? (
            <button className={item.reposted ? 'feed-act reposted' : 'feed-act'} onClick={onRepost} disabled={repostBusy} title={item.reposted ? 'Remove repost' : 'Repost'} aria-pressed={!!item.reposted}>
              <span className="feed-act-icon">{repostBusy ? <Spinner size={18} /> : <Icon name="repost" size={22} />}</span>
              <span>{item.reposted ? 'Reposted' : 'Repost'}</span>
            </button>
          ) : null}
          <button className="feed-act" onClick={onShare} title="Send to a chat">
            <span className="feed-act-icon">
              <Icon name="shareArrow" size={24} />
            </span>
            <span>{item.stats.shares ? formatCount(item.stats.shares) : 'Share'}</span>
          </button>
          {item.video?.download ? (
            <a className="feed-act" href={item.video.download} download title="Save the video">
              <span className="feed-act-icon">
                <Icon name="download" size={22} />
              </span>
              <span>Save</span>
            </a>
          ) : null}
          <button className="feed-act" onClick={onToggleMute} title={muted ? 'Unmute' : 'Mute'}>
            <span className="feed-act-icon">
              <Icon name={muted ? 'mute' : 'volume'} size={22} />
            </span>
            <span>{muted ? 'Muted' : 'Sound'}</span>
          </button>
          <a className="feed-act" href={item.url} target="_blank" rel="noopener noreferrer" title="Open on TikTok">
            <span className="feed-act-icon">
              <Icon name="link" size={22} />
            </span>
            <span>Open</span>
          </a>
        </div>
      </div>
    </div>
  );
}

type ReplyTarget = { top: string; toReply: string | null; who: string };

/** Comments with TikTok's threads: likes, "View N replies", and replying to a comment or to a reply in its thread. */
function CommentsPanel({ item, onClose, onPosted }: { item: FeedItem; onClose: () => void; onPosted: (what: string) => void }) {
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  /** Per thread: the loaded replies, and where the next page starts (null = all there). */
  const [threads, setThreads] = useState<Record<string, { replies: FeedComment[]; cursor: string | null; loading: boolean }>>({});
  const input = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setComments((await api.feedComments(item.id)).comments);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadReplies = async (c: FeedComment) => {
    const cur = threads[c.id];
    setThreads((t) => ({ ...t, [c.id]: { replies: cur?.replies ?? [], cursor: cur?.cursor ?? null, loading: true } }));
    try {
      const r = await api.feedReplies(item.id, c.id, cur?.cursor ?? null);
      setThreads((t) => {
        const old = cur?.replies ?? [];
        const merged = [...old, ...r.comments.filter((n) => !old.some((o) => o.id === n.id))];
        return { ...t, [c.id]: { replies: merged, cursor: r.more ? r.cursor : null, loading: false } };
      });
    } catch (e) {
      setThreads((t) => ({ ...t, [c.id]: { replies: cur?.replies ?? [], cursor: cur?.cursor ?? null, loading: false } }));
      setError(errorMessage(e));
    }
  };

  const setLiked = (id: string, liked: boolean) => {
    const upd = (c: FeedComment): FeedComment =>
      c.id === id ? { ...c, liked, likes: c.likes === null ? null : Math.max(0, c.likes + (liked ? 1 : -1)) } : { ...c, replies: c.replies.map(upd) };
    setComments((cs) => cs?.map(upd) ?? cs);
    setThreads((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { ...v, replies: v.replies.map(upd) }])));
  };

  const like = async (c: FeedComment) => {
    const want = !c.liked;
    setLiked(c.id, want);
    try {
      await api.feedCommentLike(item.id, c.id, want);
    } catch (e) {
      setLiked(c.id, !want);
      setError(errorMessage(e));
    }
  };

  const startReply = (top: FeedComment, to: FeedComment | null) => {
    const who = (to ?? top).author.username ?? (to ?? top).author.name ?? 'someone';
    setReplyTo({ top: top.id, toReply: to ? to.id : null, who });
    input.current?.focus();
  };

  const post = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      if (replyTo) {
        const r = await api.feedReply(item.id, replyTo.top, body, replyTo.toReply);
        setThreads((t) => ({ ...t, [replyTo.top]: { replies: r.comments, cursor: r.more ? r.cursor : null, loading: false } }));
        setComments((cs) => cs?.map((c) => (c.id === replyTo.top ? { ...c, replyCount: Math.max(c.replyCount ?? 0, r.comments.length) } : c)) ?? cs);
        onPosted('Reply posted.');
      } else {
        setComments((await api.feedComment(item.id, body)).comments);
        onPosted('Comment posted.');
      }
      setText('');
      setReplyTo(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="feed-comments" aria-label="Comments">
      <header>
        <strong>{loading ? 'Loading comments…' : item.stats.comments ? `${formatCount(item.stats.comments)} comments` : comments?.length ? `${comments.length} comments` : 'Comments'}</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="feed-comment-list">
        {loading ? (
          <div className="feed-comments-state">
            <Spinner size={22} />
          </div>
        ) : null}
        {error && !loading && !comments ? (
          <div className="feed-comments-state">
            <p className="small">{error}</p>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}
        {!loading && comments && comments.length === 0 ? <p className="muted small">No comments on this video yet.</p> : null}
        {(comments ?? []).map((c) => {
          const th = threads[c.id];
          // Before a thread is opened, TikTok's list carries its first reply or two; once opened, the thread's pages win.
          const replies = th ? th.replies : c.replies;
          const total = c.replyCount ?? c.replies.length;
          const left = th ? (th.cursor ? Math.max(1, total - th.replies.length) : 0) : Math.max(0, total - c.replies.length);
          return (
            <div key={c.id} className="feed-comment depth-0">
              <CommentLine c={c} onLike={() => void like(c)} onReply={() => startReply(c, null)} />
              {replies.map((r) => (
                <div key={r.id} className="feed-comment depth-1">
                  <CommentLine c={r} onLike={() => void like(r)} onReply={() => startReply(c, r)} />
                </div>
              ))}
              {left > 0 || th?.loading ? (
                <button className="feed-more-replies" onClick={() => void loadReplies(c)} disabled={th?.loading}>
                  {th?.loading ? 'Loading…' : th ? `View more replies` : `View ${formatCount(left)} ${left === 1 ? 'reply' : 'replies'}`}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {error && comments ? <p className="small err-inline">{error}</p> : null}
      {replyTo ? (
        <div className="feed-replying">
          <span className="small">Replying to @{replyTo.who}</span>
          <button className="icon-btn" onClick={() => setReplyTo(null)} title="Cancel reply" aria-label="Cancel reply">
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
      <div className="feed-comment-form">
        <input
          ref={input}
          type="text"
          maxLength={150}
          placeholder={replyTo ? `Reply to @${replyTo.who}…` : 'Add a comment…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void post();
            if (e.key === 'Escape') setReplyTo(null);
          }}
        />
        <button className="btn" onClick={() => void post()} disabled={sending || !text.trim()}>
          Post
        </button>
      </div>
    </aside>
  );
}

function CommentLine({ c, onLike, onReply }: { c: FeedComment; onLike: () => void; onReply: () => void }) {
  return (
    <div className="feed-comment-line">
      <div className="feed-comment-body">
        <div className="feed-comment-head">
          {c.author.username ? (
            <Link to={`/profile/${encodeURIComponent(c.author.username)}`}>
              <strong>@{c.author.username}</strong>
            </Link>
          ) : (
            <strong>{c.author.name ?? 'Someone'}</strong>
          )}
        </div>
        <p>{c.text}</p>
        <button className="feed-reply-btn" onClick={onReply}>
          Reply
        </button>
      </div>
      <button className={c.liked ? 'feed-comment-like liked' : 'feed-comment-like'} onClick={onLike} aria-pressed={!!c.liked} title={c.liked ? 'Unlike' : 'Like'}>
        <Icon name={c.liked ? 'heartFill' : 'heart'} size={16} />
        <span className="small">{c.likes ? formatCount(c.likes) : ''}</span>
      </button>
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
