import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark, TtStatePill } from '../components/ui';
import { useAppState } from '../state/AppState';

type NavEntry = { to: string; label: string; icon: IconName; iconOn: IconName; end?: boolean; tab?: string };

/**
 * TikTok-style navigation: TikTok Web's sidebar on wide screens (240 px with labels; 72 px icons only on the messages
 * pages and under 1024 px), and the TikTok app's bottom tab bar on phones (Home · Stories · Inbox · Unsent · Profile,
 * where "Profile" opens a sheet with the rest).
 */
const NAV: NavEntry[] = [
  { to: '/feed', label: 'For You', icon: 'home', iconOn: 'homeFill', tab: 'Home' },
  { to: '/', label: 'Messages', icon: 'inbox', iconOn: 'inboxFill', end: true, tab: 'Inbox' },
  { to: '/stories', label: 'Stories', icon: 'stories', iconOn: 'storiesFill', tab: 'Stories' },
  { to: '/deleted', label: 'Unsent', icon: 'deleted', iconOn: 'deletedFill', tab: 'Unsent' },
  { to: '/me', label: 'Profile', icon: 'user', iconOn: 'userFill' },
  { to: '/tiktok', label: 'TikTok', icon: 'monitor', iconOn: 'monitorFill' },
];
/** The phone tab bar, in TikTok's order of slots (the rest lives in the Profile sheet). */
const TABS = ['/feed', '/stories', '/', '/deleted'];

export function MainLayout() {
  const { tt, refresh, state } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const inChat = location.pathname.startsWith('/chat/');
  const onMessages = inChat || location.pathname === '/';
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMoreOpen(false), [location.pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    // The rail's popup and the phone sheet (with its tab button) both count as "inside".
    const away = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!moreRef.current?.contains(t) && !t.closest?.('.more-sheet, .tabbar')) setMoreOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [moreOpen]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
      navigate('/login', { replace: true });
    }
  };

  const needsAttention = tt && (tt.state === 'login' || tt.state === 'challenge');
  const ttDown = !tt || !(tt.state === 'ready' || tt.state === 'syncing');
  const extra: NavEntry[] = [
    ...(state?.role === 'admin' ? [{ to: '/admin', label: 'Users', icon: 'group', iconOn: 'groupFill' } as NavEntry] : []),
    { to: '/settings', label: 'Settings', icon: 'settings', iconOn: 'settingsFill' },
  ];
  const isOn = (to: string, active: boolean) => active || (to === '/' && inChat);

  const railItem = (n: NavEntry) => (
    <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `rail-item${isOn(n.to, isActive) ? ' active' : ''}`} title={n.label} aria-label={n.label}>
      {({ isActive }) => (
        <>
          <span className="rail-icon">
            <Icon name={isOn(n.to, isActive) ? n.iconOn : n.icon} size={26} />
            {n.to === '/tiktok' && ttDown ? <span className="nav-dot" aria-label="Needs attention" /> : null}
          </span>
          <span className="rail-label">{n.label}</span>
        </>
      )}
    </NavLink>
  );

  const tabItem = (n: NavEntry) => (
    <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab-item${isOn(n.to, isActive) ? ' active' : ''}`} aria-label={n.label}>
      {({ isActive }) => (
        <>
          <span className="rail-icon">
            <Icon name={isOn(n.to, isActive) ? n.iconOn : n.icon} size={24} />
          </span>
          <span className="tab-label">{n.tab ?? n.label}</span>
        </>
      )}
    </NavLink>
  );

  const menu = (sheet: boolean) => (
    <div className="more-menu" role="menu">
      {sheet ? (
        <div className="more-who">
          <span className="more-avatar">
            <Icon name="userFill" size={22} />
          </span>
          <span>
            <b>{state?.username ? `@${state.username}` : 'tiktok_logger'}</b>
            <TtStatePill status={tt} />
          </span>
        </div>
      ) : null}
      {(sheet ? [...NAV.filter((n) => !TABS.includes(n.to)), ...extra, { to: '/search', label: 'Search', icon: 'search', iconOn: 'search' } as NavEntry] : []).map((n) => (
        <NavLink key={n.to} to={n.to} role="menuitem" className={({ isActive }) => (isActive ? 'more-item active' : 'more-item')}>
          <Icon name={n.icon} size={22} />
          <span>{n.label}</span>
          {n.to === '/tiktok' ? <TtStatePill status={tt} compact /> : null}
        </NavLink>
      ))}
      {sheet ? null : (
        <div className="more-status">
          <TtStatePill status={tt} />
        </div>
      )}
      <div className="more-sep" />
      <button role="menuitem" className="more-item" onClick={() => void logout()}>
        <Icon name="logout" size={22} />
        <span>Log out{state?.username ? ` @${state.username}` : ''}</span>
      </button>
    </div>
  );

  return (
    <div className={`app-shell${inChat ? ' in-chat' : ''}${onMessages ? ' narrow' : ''}${location.pathname === '/feed' ? ' on-feed' : ''}`}>
      <nav className="rail" aria-label="Main">
        <NavLink to="/feed" className="rail-brand" aria-label="tiktok_logger home">
          <BrandMark size={32} />
          <span className="wordmark">tiktok_logger</span>
        </NavLink>
        <NavLink to="/search" className={({ isActive }) => `rail-search${isActive ? ' active' : ''}`} aria-label="Search" title="Search">
          <Icon name="search" size={20} />
          <span className="rail-label">Search</span>
        </NavLink>
        <div className="rail-top">
          {NAV.map(railItem)}
          {extra.map(railItem)}
          <div className="rail-more" ref={moreRef}>
            <button className={moreOpen ? 'rail-item active' : 'rail-item'} onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen} title="More">
              <span className="rail-icon">
                <Icon name="menuDots" size={26} />
              </span>
              <span className="rail-label">More</span>
            </button>
            {moreOpen ? menu(false) : null}
          </div>
        </div>
        <div className="rail-foot">
          <span className="rail-foot-title">{state?.username ? `@${state.username}` : 'tiktok_logger'}</span>
          <span>Your TikTok messages, logged and encrypted.</span>
        </div>
      </nav>
      <main className="app-main">
        {needsAttention ? (
          <div className="banner warn">
            <Icon name="warning" size={18} />
            <span>
              {tt.state === 'login' ? 'TikTok is logged out' : 'TikTok asks for a confirmation'} — new messages are not being logged.{' '}
              <NavLink to="/tiktok">Open the TikTok screen</NavLink> to fix it.
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Tabs">
        {NAV.filter((n) => TABS.includes(n.to))
          .sort((a, b) => TABS.indexOf(a.to) - TABS.indexOf(b.to))
          .map(tabItem)}
        <button className={moreOpen ? 'tab-item active' : 'tab-item'} onClick={() => setMoreOpen((v) => !v)} aria-label="Profile" aria-haspopup="menu" aria-expanded={moreOpen}>
          <span className="rail-icon">
            <Icon name={moreOpen ? 'userFill' : 'user'} size={24} />
            {ttDown ? <span className="nav-dot" /> : null}
          </span>
          <span className="tab-label">Profile</span>
        </button>
      </nav>
      {moreOpen ? (
        <div className="more-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
            <span className="sheet-grip" />
            {menu(true)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
