import QRCode from 'qrcode';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AuditEntry, SessionInfo, Settings, TotpSetupResponse } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Avatar, ConfirmButton, ErrorNote, Spinner, TtStatePill } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useAppState } from '../state/AppState';
import { RecoveryKeyBox } from './Auth';

function Section({ id, title, children, danger = false }: { id: string; title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section id={id} className={danger ? 'settings-section danger' : 'settings-section'}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      if (success) setOk(success);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, ok, run };
}

function PasswordSection() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return;
    if (await a.run(() => api.changePassword(cur, next), 'Password changed. Other sessions were logged out.')) {
      setCur('');
      setNext('');
      setConfirm('');
    }
  };
  return (
    <Section id="password" title="Password">
      <form className="form narrow" onSubmit={submit}>
        <label>
          Current password
          <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label>
          New password
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
        </label>
        <label>
          Confirm new password
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {next && confirm && next !== confirm ? <p className="error-note">Passwords do not match.</p> : null}
        <ErrorNote error={a.error} />
        {a.ok ? <p className="ok-note">{a.ok}</p> : null}
        <button className="btn primary" disabled={a.busy}>
          Change password
        </button>
      </form>
    </Section>
  );
}

function TotpSection() {
  const { state, refresh } = useAppState();
  const enabled = !!state?.totpEnabled;
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const a = useAsync();

  const start = () =>
    a.run(async () => {
      const s = await api.totpSetup();
      setSetup(s);
      setQr(await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 220 }));
    });

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.totpEnable(code.trim(), password), 'Two-factor authentication enabled.')) {
      setSetup(null);
      setQr(null);
      setCode('');
      setPassword('');
      await refresh();
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    if (await a.run(() => api.totpDisable(password, code.trim()), 'Two-factor authentication disabled.')) {
      setPassword('');
      setCode('');
      await refresh();
    }
  };

  return (
    <Section id="2fa" title="Two-factor authentication (TOTP)">
      <p className="muted">Require a 6-digit code from an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) at login.</p>
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
      {enabled ? (
        <form className="form narrow" onSubmit={disable}>
          <p className="ok-note">
            <Icon name="shield" size={16} /> Two-factor authentication is enabled.
          </p>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <label>
            Current code
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern="[0-9 ]{6,7}" />
          </label>
          <ErrorNote error={a.error} />
          <button className="btn danger" disabled={a.busy}>
            Disable 2FA
          </button>
        </form>
      ) : setup ? (
        <form className="form narrow" onSubmit={enable}>
          {qr ? <img src={qr} alt="Scan this QR code with your authenticator app" className="totp-qr" width={220} height={220} /> : null}
          <p className="small muted">
            Or enter this secret manually: <code className="mono">{setup.secret}</code>
          </p>
          <label>
            Code from the app
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required pattern="[0-9 ]{6,7}" autoFocus />
          </label>
          <label>
            Your password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <ErrorNote error={a.error} />
          <div className="row gap">
            <button className="btn primary" disabled={a.busy}>
              Verify &amp; enable
            </button>
            <button type="button" className="btn ghost" onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <ErrorNote error={a.error} />
          <button className="btn" onClick={start} disabled={a.busy}>
            {a.busy ? <Spinner size={16} /> : 'Enable 2FA'}
          </button>
        </>
      )}
    </Section>
  );
}

function TotpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { state } = useAppState();
  if (!state?.totpEnabled) return null;
  return (
    <label>
      Authentication code
      <input inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => onChange(e.target.value)} required pattern="[0-9 ]{6,7}" />
    </label>
  );
}

function RecoverySection() {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await a.run(async () => {
      setKey((await api.rotateRecoveryKey(password, totp.trim() || undefined)).recoveryKey);
      setPassword('');
      setTotp('');
    });
  };
  return (
    <Section id="recovery" title="Recovery key">
      <p className="muted">Creates a new recovery key and invalidates the old one. Store the new key safely — it is shown only once.</p>
      {key ? (
        <>
          <RecoveryKeyBox recoveryKey={key} />
          <button className="btn" onClick={() => setKey(null)}>
            I have saved it
          </button>
        </>
      ) : (
        <form className="form narrow" onSubmit={submit}>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <TotpField value={totp} onChange={setTotp} />
          <ErrorNote error={a.error} />
          <button className="btn" disabled={a.busy}>
            Generate new recovery key
          </button>
        </form>
      )}
    </Section>
  );
}

function SessionsSection() {
  const { refresh } = useAppState();
  const navigate = useNavigate();
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const a = useAsync();
  const load = useCallback(() => api.sessions().then(setList, () => setList([])), []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Section id="sessions" title="Sessions">
      <ErrorNote error={a.error} />
      {!list ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Device</th>
                <th>IP</th>
                <th>Last active</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="ua">
                    {s.current ? <span className="badge green">this device</span> : null} {s.userAgent ?? 'Unknown'}
                  </td>
                  <td className="mono small">{s.ip ?? '—'}</td>
                  <td>{formatDateTime(s.lastSeenAt)}</td>
                  <td>{formatDateTime(s.expiresAt)}</td>
                  <td>
                    <button
                      className="btn tiny ghost"
                      onClick={() =>
                        a.run(async () => {
                          await api.revokeSession(s.id);
                          if (s.current) {
                            await refresh();
                            navigate('/login');
                          } else await load();
                        })
                      }
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmButton
        className="btn"
        confirmLabel="Log out all sessions"
        onConfirm={() =>
          a.run(async () => {
            await api.logoutAll();
            await refresh();
            navigate('/login');
          })
        }
      >
        Log out everywhere
      </ConfirmButton>
    </Section>
  );
}

function LoggingSection() {
  const [s, setS] = useState<Settings | null>(null);
  const a = useAsync();
  useEffect(() => {
    api.settings().then(setS, () => undefined);
  }, []);
  if (!s) return <Spinner />;
  const save = (patch: Partial<Settings>) => a.run(async () => setS(await api.updateSettings(patch)), 'Saved.');
  return (
    <Section id="logging" title="Logging">
      <label className="check">
        <input type="checkbox" checked={s.downloadHistoryMedia} onChange={(e) => save({ downloadHistoryMedia: e.target.checked })} /> Download media of imported history (not only new messages)
      </label>
      <label className="check">
        <input type="checkbox" checked={!!s.readReceipts} onChange={(e) => save({ readReceipts: e.target.checked })} /> Mark chats as seen on TikTok when I open them here (senders see “Seen”)
      </label>
      <div className="form narrow">
        <label>
          Maximum media size to download (MB)
          <input type="number" min={1} max={2000} defaultValue={s.mediaMaxMb} onBlur={(e) => Number(e.target.value) !== s.mediaMaxMb && save({ mediaMaxMb: Number(e.target.value) })} />
        </label>
        <label>
          Messages to import per chat on first login
          <input
            type="number"
            min={0}
            max={2000}
            defaultValue={s.historyPerChat}
            onBlur={(e) => Number(e.target.value) !== s.historyPerChat && save({ historyPerChat: Number(e.target.value) })}
          />
        </label>
      </div>
      <p className="muted small">View-once photos and videos are never logged. The history import pauses between requests to TikTok, so a big inbox takes a while.</p>
      <label className="check">
        <input type="checkbox" checked={s.sessionRefresh} onChange={(e) => save({ sessionRefresh: e.target.checked })} /> Refresh the TikTok session in the background regularly
      </label>
      <div className="form narrow">
        <label>
          Every (hours)
          <input
            type="number"
            min={1}
            max={24}
            disabled={!s.sessionRefresh}
            defaultValue={s.sessionRefreshHours}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 24 && v !== s.sessionRefreshHours) save({ sessionRefreshHours: v });
            }}
          />
        </label>
      </div>
      <p className="muted small">
        Reloads the background TikTok tab like a person coming back to it. Each time is randomly up to 10 minutes earlier or later than the
        interval, so it never happens on an exact schedule.
      </p>

      <h3 className="settings-sub">Re-checking for deleted messages</h3>
      <div className="form narrow">
        <label>
          Re-read the newest conversations every (minutes)
          <input
            type="number"
            min={5}
            max={240}
            defaultValue={s.reconcileMinutes}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 5 && v <= 240 && v !== s.reconcileMinutes) save({ reconcileMinutes: v });
            }}
          />
        </label>
      </div>
      <p className="muted small">
        TikTok shows a conversation only to a browser that opens it, and opening it marks it seen for the other person. The import
        therefore re-reads the newest conversations every so often: a message that is no longer there stays in the log, marked
        &ldquo;Gone from TikTok&rdquo;. Fewer minutes means more TikTok traffic.
      </p>
      <ErrorNote error={a.error} />
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
    </Section>
  );
}

function TikTokSection() {
  const { tt } = useAppState();
  const a = useAsync();
  return (
    <Section id="tiktok" title="TikTok connection">
      <div className="row gap wrap">
        <TtStatePill status={tt} />
        <span className="muted small">{tt?.detail}</span>
        {tt?.me ? <span className="small">Logged in: {tt.me.name} {tt.me.username ? `@${tt.me.username}` : ''}</span> : null}
        <span className="muted small">Media queue: {tt?.mediaQueue ?? 0}</span>
        <span className="muted small">Last live update: {tt?.lastEventAt ? formatDateTime(tt.lastEventAt) : '—'}</span>
      </div>
      <div className="row gap">
        <button className="btn" onClick={() => a.run(api.ttRestart, 'Restarting…')} disabled={a.busy}>
          <Icon name="refresh" size={16} /> Reload TikTok
        </button>
        <ConfirmButton className="btn" confirmLabel="Log TikTok out" onConfirm={() => void a.run(api.ttLogout, 'Logged out of TikTok.')}>
          Log the browser out of TikTok
        </ConfirmButton>
      </div>
      <Diagnostics />
      <ErrorNote error={a.error} />
      {a.ok ? <p className="ok-note">{a.ok}</p> : null}
    </Section>
  );
}

/**
 * What tiktok_logger is reading from TikTok, and the page's structure — the one thing needed when TikTok renames an
 * element and a role stops matching (`TT_DOM_SELECTORS` in .env fixes it without a new release).
 */
function Diagnostics() {
  const [diag, setDiag] = useState<string | null>(null);
  const [probe, setProbe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.ttDiagnostics();
      setDiag(
        [
          `state: ${d.state}${d.detail ? ` (${d.detail})` : ''}`,
          `account: ${d.meId ?? 'unknown'}`,
          `chats stored: ${d.chats}, messages stored: ${d.messages}`,
          `stream frames: ${d.watcher.frames}, IM answers: ${d.watcher.bodies}, sockets: ${d.watcher.sockets}`,
          `last frame: ${d.watcher.lastFrameAt ? formatDateTime(d.watcher.lastFrameAt) : 'none'}`,
          `recent IM paths: ${d.watcher.recentPaths.join(', ') || 'none'}`,
        ].join('\n'),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const outline = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.ttProbe();
      const lines = p.nodes.slice(0, 220).map((n) => `${'  '.repeat(Math.min(n.d, 12))}${n.tag}${n.e2e ? ` [${n.e2e}]` : ''}${n.role ? ` role=${n.role}` : ''}${n.aria ? ` aria="${n.aria}"` : ''} ${n.cls.join('.')} ${n.w}x${n.h}`);
      setProbe(`${p.url}\n${lines.join('\n')}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked: the text is selectable anyway */
    }
  };
  return (
    <>
      <h3 className="settings-sub">Diagnostics</h3>
      <div className="row gap wrap">
        <button className="btn" onClick={() => void load()} disabled={busy}>
          Check what is being read
        </button>
        <button className="btn" onClick={() => void outline()} disabled={busy}>
          Show the page's structure
        </button>
      </div>
      {diag ? (
        <div className="row between gap">
          <pre className="diag">{diag}</pre>
          <button className="link-btn" onClick={() => void copy(diag)}>
            copy
          </button>
        </div>
      ) : null}
      {probe ? (
        <div className="row between gap">
          <pre className="diag">{probe}</pre>
          <button className="link-btn" onClick={() => void copy(probe)}>
            copy
          </button>
        </div>
      ) : null}
      <p className="muted small">
        If TikTok changes its page and messages stop appearing, copy the structure above: the selectors can be extended in <code>.env</code> with{' '}
        <code>TT_DOM_SELECTORS</code> without rebuilding anything.
      </p>
      <ErrorNote error={error} />
    </>
  );
}

function AuditSection() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  useEffect(() => {
    api.audit().then(setRows, () => setRows([]));
  }, []);
  return (
    <Section id="audit" title="Security log">
      {!rows ? (
        <Spinner />
      ) : (
        <div className="table-wrap audit">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={/fail|wipe|revoked|logout/.test(r.event) ? 'warn-row' : undefined}>
                  <td>{formatDateTime(r.ts)}</td>
                  <td className="mono small">{r.event}</td>
                  <td className="mono small">{r.ip ?? '—'}</td>
                  <td className="small">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function DangerSection() {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [armed, setArmed] = useState(false);
  const a = useAsync();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!armed) return setArmed(true);
    if (await a.run(() => api.wipe(password, totp.trim() || undefined), 'All logged messages and media were deleted.')) {
      setPassword('');
      setTotp('');
      setArmed(false);
    }
  };
  return (
    <Section id="danger" title="Danger zone" danger>
      <p className="muted">Permanently deletes every logged message, edit, reaction and media file. Your account and the TikTok login stay; logging continues for new messages.</p>
      <form className="form narrow" onSubmit={submit}>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <TotpField value={totp} onChange={setTotp} />
        <ErrorNote error={a.error} />
        {a.ok ? <p className="ok-note">{a.ok}</p> : null}
        <div className="row gap">
          <button className="btn danger" disabled={a.busy}>
            {armed ? 'Click again to wipe everything' : 'Wipe all logged data'}
          </button>
          {armed ? (
            <button type="button" className="btn ghost" onClick={() => setArmed(false)}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </Section>
  );
}

export function SettingsPage() {
  const { state } = useAppState();
  return (
    <div className="page settings">
      <header className="page-head">
        <h1>
          <Icon name="settings" /> Settings
        </h1>
        <p className="muted">Signed in as {state?.username}</p>
        <nav className="toc">
          {[
            ['password', 'Password'],
            ['2fa', '2FA'],
            ['recovery', 'Recovery key'],
            ['sessions', 'Sessions'],
            ['logging', 'Logging'],
            ['tiktok', 'TikTok'],
            ['audit', 'Security log'],
            ['danger', 'Danger zone'],
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <PasswordSection />
      <TotpSection />
      <RecoverySection />
      <SessionsSection />
      <LoggingSection />
      <TikTokSection />
      <AuditSection />
      <DangerSection />
    </div>
  );
}

/** Pick whose stories are logged: accounts seen in the stories bar (they appear once they post a story). */
