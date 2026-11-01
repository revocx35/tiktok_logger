import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { FeedItem, ProfileTab, TtProfile } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { ErrorNote, Spinner } from '../components/ui';
import { VideoStack } from '../components/VideoStack';
import { formatCount } from '../lib/format';

const TAB_INFO: Record<ProfileTab, { label: string; icon: IconName; empty: string }> = {
  videos: { label: 'Videos', icon: 'grid', empty: 'No videos yet.' },
  reposts: { label: 'Reposts', icon: 'repost', empty: 'No reposts yet.' },
  favorites: { label: 'Favorites', icon: 'bookmark', empty: 'Nothing saved to Favorites yet.' },
  liked: { label: 'Liked', icon: 'heart', empty: 'No liked videos yet.' },
};

/**
 * A TikTok profile (v1.15): the owner's own (`/me`) or anyone's (`/profile/:username`), read through the server's
 * browser. The header follows TikTok's (avatar, handle, follow button, Following · Followers · Likes, bio), then the
 * lists as a grid of covers; a tap opens the list in the same swiping player as For You.
 */
export function ProfilePage({ me = false }: { me?: boolean }) {
  const params = useParams();
  const username = me ? 'me' : params.username ?? '';
  const navigate = useNavigate();
  const [profile, setProfile] = useState<TtProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProfileTab>('videos');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    let live = true;
    setProfile(null);
    setError(null);
    setItems([]);
    setTab('videos');
    api.profile(username).then(
      (p) => {
        if (!live) return;
        setProfile(p);
        if (me && p.username) document.title = `@${p.username} · tiktok_logger`;
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [username, me]);

  const load = useCallback(
    async (fresh: boolean) => {
      if (!profile || !profile.tabs.includes(tab)) return;
      const seq = fresh ? ++loadSeq.current : loadSeq.current;
      setLoading(true);
      setListError(null);
      try {
        const r = await api.profileVideos(me ? 'me' : profile.username, tab, fresh ? null : cursor);
        if (seq !== loadSeq.current) return;
        setItems((old) => (fresh ? r.items : [...old, ...r.items.filter((n) => !old.some((o) => o.id === n.id))]));
        setCursor(r.cursor);
        setMore(r.more);
      } catch (e) {
        if (seq === loadSeq.current) setListError(errorMessage(e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [profile, tab, cursor, me],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setMore(false);
    void load(true);
    // Only when the profile or the tab changes; paging goes through the sentinel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.username, tab]);

  // The next page loads when the end of the grid comes into view.
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting && !loading) void load(false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loading, load]);

  const toggleFollow = async () => {
    if (!profile || profile.me || following) return;
    const want = !profile.following;
    setFollowing(true);
    setError(null);
    try {
      const r = await api.follow(profile.username, want);
      setProfile((p) => (p ? { ...p, following: r.following, friends: r.following && p.friends, stats: { ...p.stats, followers: p.stats.followers === null ? null : p.stats.followers + (r.following === !!profile.following ? 0 : r.following ? 1 : -1) } } : p));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setFollowing(false);
    }
  };

  if (error && !profile) {
    return (
      <div className="profile-page">
        <div className="profile-state">
          <Icon name="user" size={40} />
          <ErrorNote error={error} />
          <button className="btn" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="profile-page">
        <div className="profile-state">
          <Spinner size={30} />
        </div>
      </div>
    );
  }

  const followLabel = profile.friends ? 'Friends' : profile.following ? 'Following' : 'Follow';

  return (
    <div className="profile-page">
      <header className="profile-head">
        {!me ? (
          <button className="icon-btn profile-back" onClick={() => navigate(-1)} aria-label="Back" title="Back">
            <Icon name="back" size={22} />
          </button>
        ) : null}
        <div className="profile-avatar">{profile.avatar ? <img src={profile.avatar} alt="" /> : <Icon name="userFill" size={48} />}</div>
        <div className="profile-who">
          <h1>
            {profile.username}
            {profile.verified ? <Icon name="verified" size={20} className="profile-verified" title="Verified" /> : null}
          </h1>
          {profile.name ? <p className="profile-name">{profile.name}</p> : null}
          <div className="profile-actions">
            {profile.me ? (
              <a className="btn" href={profile.url} target="_blank" rel="noopener noreferrer">
                Open on TikTok
              </a>
            ) : (
              <button className={profile.following ? 'btn profile-following' : 'btn primary'} onClick={() => void toggleFollow()} disabled={following} aria-pressed={!!profile.following}>
                {following ? <Spinner size={14} /> : null} {followLabel}
              </button>
            )}
            {!profile.me ? (
              <a className="btn icon-only" href={profile.url} target="_blank" rel="noopener noreferrer" title="Open on TikTok" aria-label="Open on TikTok">
                <Icon name="link" size={18} />
              </a>
            ) : null}
          </div>
          <p className="profile-stats">
            <span>
              <b>{formatCount(profile.stats.following)}</b> Following
            </span>
            <span>
              <b>{formatCount(profile.stats.followers)}</b> Followers
            </span>
            <span>
              <b>{formatCount(profile.stats.likes)}</b> Likes
            </span>
          </p>
          {profile.bio ? <p className="profile-bio">{profile.bio}</p> : null}
          {profile.link ? (
            <a className="profile-link" href={profile.link} target="_blank" rel="noopener noreferrer nofollow">
              <Icon name="link" size={14} /> {profile.link.replace(/^https?:\/\//, '')}
            </a>
          ) : null}
          <ErrorNote error={error} />
        </div>
      </header>

      {profile.tabs.length ? (
        <nav className="profile-tabs" aria-label="Lists">
          {profile.tabs.map((t) => (
            <button key={t} className={t === tab ? 'profile-tab active' : 'profile-tab'} onClick={() => setTab(t)} aria-pressed={t === tab}>
              <Icon name={TAB_INFO[t].icon} size={18} />
              <span>{TAB_INFO[t].label}</span>
            </button>
          ))}
        </nav>
      ) : (
        <div className="profile-state">
          <Icon name="lock" size={36} />
          <p>This account is private. Follow it to see its videos.</p>
        </div>
      )}

      {profile.tabs.length ? (
        <>
          <div className="profile-grid">
            {items.map((it) => (
              <button key={it.id} className="profile-tile" onClick={() => setViewing(it.id)} aria-label={it.caption ? `Play: ${it.caption.slice(0, 60)}` : 'Play video'}>
                {it.video?.poster ? <img src={it.video.poster} alt="" loading="lazy" /> : <Icon name="video" size={28} />}
                <span className="profile-tile-plays">
                  <Icon name="play" size={14} /> {formatCount(it.stats.plays)}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <div className="profile-state small">
              <Spinner size={22} />
            </div>
          ) : null}
          {!loading && !items.length && !listError ? <p className="profile-state muted">{TAB_INFO[tab].empty}</p> : null}
          {listError ? (
            <div className="profile-state">
              <ErrorNote error={listError} />
              <button className="btn" onClick={() => void load(items.length === 0)}>
                Try again
              </button>
            </div>
          ) : null}
          <div ref={sentinel} className="profile-sentinel" />
        </>
      ) : null}

      {viewing ? <ProfileViewer items={items} setItems={setItems} startAt={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

/** The tapped list in the For You player, full screen, with a close button (Escape closes too). */
function ProfileViewer({ items, setItems, startAt, onClose }: { items: FeedItem[]; setItems: React.Dispatch<React.SetStateAction<FeedItem[]>>; startAt: string; onClose: () => void }) {
  const [activeId, setActiveId] = useState<string | null>(startAt);
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="profile-viewer" role="dialog" aria-label="Videos">
      <div className="feed">
        <VideoStack
          items={items}
          setItems={setItems}
          activeId={activeId}
          onActive={setActiveId}
          scroller={scroller}
          startAt={startAt}
          header={
            <button className="icon-btn profile-viewer-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <Icon name="close" size={22} />
            </button>
          }
        />
      </div>
    </div>
  );
}
