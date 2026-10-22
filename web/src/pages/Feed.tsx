import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSummary, FeedComment, FeedItem } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, ErrorNote, Modal, Spinner } from '../components/ui';
import { formatCount } from '../lib/format';

/**
 * TikTok's For You feed inside tiktok_logger.
 *
 * The videos are streamed through the server's browser (never from TikTok's CDN directly, so the signed links stay on
 * the server), likes/comments are done by clicking TikTok's own controls, and sharing is just the canonical video link
 * sent into one of the logged conversations.
 */
export function FeedPage() {
  const [item, setItem] = useState<FeedItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [muted, setMuted] = useState(true);
  const [comments, setComments] = useState<FeedComment[] | null>(null);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.feed();
      setItem(r.item);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const step = useCallback(
    async (dir: 'next' | 'prev') => {
      if (busy) return;
      setBusy(true);
      setComments(null);
      try {
        const r = await api.feedStep(dir);
        setItem(r.item);
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        void step('next');
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        void step('prev');
      } else if (e.key === 'Escape') {
        setComments(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const like = async () => {
    if (!item || busy) return;
    const want = !item.liked;
    setItem({ ...item, liked: want, stats: { ...item.stats, likes: item.stats.likes === null ? null : item.stats.likes + (want ? 1 : -1) } });
    try {
      const r = await api.feedLike(item.id, want);
      setItem((cur) => (cur ? { ...cur, liked: r.liked } : cur));
    } catch (e) {
      setItem((cur) => (cur ? { ...cur, liked: !want } : cur));
      setError(errorMessage(e));
    }
  };

  const openComments = async () => {
    if (!item) return;
    setSending(true);
    try {
      const r = await api.feedComments(item.id);
      setComments(r.comments);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const closeComments = () => {
    setComments(null);
    setCommentText('');
    void api.feedCloseComments().catch(() => undefined);
  };

  const postComment = async () => {
    if (!item || !commentText.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.feedComment(item.id, commentText.trim());
      setComments(r.comments);
      setCommentText('');
      setError(null);
      setNotice('Comment posted.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="feed">
      <div className="feed-stage">
        {loading ? (
          <div className="feed-loading">
            <Spinner size={34} />
            <p>Opening the feed in the server's browser…</p>
          </div>
        ) : item ? (
          <>
            <video
              key={item.id}
              ref={videoRef}
              className="feed-video"
              src={item.video?.src ?? undefined}
              poster={item.video?.poster ?? undefined}
              autoPlay
              loop
              playsInline
              muted={muted}
              onClick={() => setMuted((m) => !m)}
            />
            {!item.video?.src ? (
              <div className="feed-no-video">
                <Icon name="video" size={36} />
                <p>This video has no playable source (TikTok may still be loading it).</p>
                <button className="btn" onClick={() => void load()}>
                  Reload
                </button>
              </div>
            ) : null}

            <div className="feed-overlay">
              <div className="feed-meta">
                {item.author.username ? <a className="feed-author" href={item.url} target="_blank" rel="noopener noreferrer">@{item.author.username}</a> : null}
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
                <button className={item.liked ? 'feed-act liked' : 'feed-act'} onClick={() => void like()} title={item.liked ? 'Unlike' : 'Like'} aria-pressed={item.liked}>
                  <Icon name="heart" size={28} />
                  <span>{formatCount(item.stats.likes)}</span>
                </button>
                <button className="feed-act" onClick={() => void openComments()} title="Comments">
                  <Icon name="comment" size={26} />
                  <span>{formatCount(item.stats.comments)}</span>
                </button>
                <button className="feed-act" onClick={() => setShareOpen(true)} title="Send to a chat">
                  <Icon name="send" size={24} />
                  <span>Send</span>
                </button>
                <button className="feed-act" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute' : 'Mute'}>
                  <Icon name={muted ? 'mute' : 'volume'} size={24} />
                  <span>{muted ? 'Sound off' : 'Sound on'}</span>
                </button>
                <a className="feed-act" href={item.url} target="_blank" rel="noopener noreferrer" title="Open on TikTok">
                  <Icon name="link" size={22} />
                  <span>TikTok</span>
                </a>
              </div>
            </div>

            <div className="feed-nav">
              <button className="feed-arrow" onClick={() => void step('prev')} disabled={busy} title="Previous (↑)">
                <Icon name="back" size={22} />
              </button>
              <button className="feed-arrow" onClick={() => void step('next')} disabled={busy} title="Next (↓)">
                <Icon name="back" size={22} className="flip" />
              </button>
            </div>
            {busy ? <div className="feed-busy"><Spinner size={22} /></div> : null}
          </>
        ) : (
          <div className="feed-loading">
            <Icon name="video" size={36} />
            <p>No video could be read from the feed.</p>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}
      </div>

      {comments ? <CommentsPanel comments={comments} text={commentText} setText={setCommentText} onPost={() => void postComment()} onClose={closeComments} busy={sending} /> : null}
      {shareOpen && item ? <ShareDialog item={item} onClose={() => setShareOpen(false)} onSent={(name) => { setShareOpen(false); setNotice(`Sent to ${name}.`); }} /> : null}

      <div className="feed-errors">
        <ErrorNote error={error} />
        {notice ? (
          <p className="ok-note" onAnimationEnd={() => setNotice(null)}>
            {notice}
          </p>
        ) : null}
      </div>
      <p className="feed-hint muted small">↑ / ↓ or J / K to move · click the video to mute · likes and comments go through TikTok's own controls</p>
    </div>
  );
}

function CommentsPanel({
  comments,
  text,
  setText,
  onPost,
  onClose,
  busy,
}: {
  comments: FeedComment[];
  text: string;
  setText: (v: string) => void;
  onPost: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    <aside className="feed-comments" aria-label="Comments">
      <header>
        <strong>{comments.length === 1 ? '1 comment' : `${comments.length} comments`}</strong>
        <button className="icon-btn" onClick={onClose} title="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="feed-comment-list">
        {comments.length === 0 ? <p className="muted small">No comments on this video yet.</p> : null}
        {comments.map((c) => (
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

function ShareDialog({ item, onClose, onSent }: { item: FeedItem; onClose: () => void; onSent: (name: string) => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    api.chats().then(setChats, (e) => setError(errorMessage(e)));
  }, []);

  const send = async (chat: ChatSummary) => {
    setSending(chat.id);
    try {
      await api.sendText(chat.id, item.url);
      onSent(chat.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(null);
    }
  };

  return (
    <Modal title="Send this video" onClose={onClose}>
      <p className="muted small">The link opens on TikTok: {item.url}</p>
      <div className="feed-chat-picker">
        {chats === null && !error ? <Spinner size={20} /> : null}
        {(chats ?? []).map((c) => (
          <button key={c.id} className="feed-chat-row" onClick={() => void send(c)} disabled={sending !== null}>
            <Avatar id={c.id} name={c.name} url={c.avatarUrl ?? null} kind={c.kind} size={36} />
            <span>{c.name}</span>
            {sending === c.id ? <Spinner size={16} /> : <Icon name="send" size={16} />}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}
