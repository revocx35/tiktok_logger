import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AdminAuditEntry, AdminOverview, AdminUser, TtScheduleConfig, TtStatus, ResetMode, UserStatus } from '../../../shared/api';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ErrorNote, TtStatePill, Modal, Spinner } from '../components/ui';
import { formatDateTime, formatTime } from '../lib/format';
import { useAppState } from '../state/AppState';
import { RecoveryKeyBox } from './Auth';

const STATUS: Record<UserStatus, { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad' }> = {
  active: { label: 'Active', tone: 'ok' },
  pending: { label: 'Waiting for first sign-in', tone: 'warn' },
  reset: { label: 'Password reset', tone: 'warn' },
  unknown: { label: 'Not reachable', tone: 'bad' },
};

/** Where the person signs in: the port's own address when the admin gave one, else this host on that port. */
function signInUrl(o: AdminOverview, port: number | null): string {
  if (port === null) return o.defaultOrigin ?? window.location.origin;
  const own = o.ports.find((p) => p.port === port)?.origin;
  if (own) return own;
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {hint ? <p className="muted small">{hint}</p> : null}
      {children}
    </section>
  );
}

/** The admin's password (and 2FA code) — asked again for destructive actions. */
function Reauth({ password, onPassword, totp, onTotp }: { password: string; onPassword: (v: string) => void; totp: string; onTotp: (v: string) => void }) {
  const { state } = useAppState();
  return (
    <>
      <label>
        Your admin password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => onPassword(e.target.value)} required />
      </label>
      {state?.totpEnabled ? (
        <label>
          Authentication code
          <input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => onTotp(e.target.value)} required pattern="[0-9 ]{6,7}" />
        </label>
      ) : null}
    </>
  );
}

function TempPassword({ value, who, url }: { value: string; who: string; url: string }) {
  return (
    <>
      <p>
        Give <strong>{who}</strong> this temporary password. It is shown only now.
      </p>
      <RecoveryKeyBox recoveryKey={value} />
      <p className="muted small">
        They sign in at <span className="mono">{url}</span> with their username and this password, and are then asked to choose a password of their own. The temporary password stops working
        once they have.
      </p>
    </>
  );
}

function CreateModal({ o, onClose }: { o: AdminOverview; onClose: () => void }) {
  const [res, setRes] = useState<{ user: AdminUser; temporaryPassword: string } | null>(null);
  return (
    <Modal title={res ? 'User created' : 'Add a user'} onClose={onClose}>
      {res ? (
        <>
          <TempPassword value={res.temporaryPassword} who={res.user.username} url={signInUrl(o, res.user.port)} />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <CreateForm o={o} onCreated={setRes} />
      )}
    </Modal>
  );
}

function CreateForm({ o, onCreated }: { o: AdminOverview; onCreated: (r: { user: AdminUser; temporaryPassword: string }) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.adminCreateUser({ username: username.trim(), ...(password ? { password } : {}), port: port ? Number(port) : null }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} maxLength={32} pattern="[A-Za-z0-9._\-]{3,32}" autoFocus autoComplete="off" />
      </label>
      <label>
        Temporary password <span className="muted">(leave empty to generate one)</span>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} maxLength={256} autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Port
        <PortSelect o={o} value={port} onChange={setPort} />
      </label>
      <ErrorNote error={error} />
      <button className="btn primary" disabled={busy}>
        {busy ? <Spinner size={18} /> : 'Create user'}
      </button>
    </form>
  );
}

function PortSelect({ o, value, onChange, disabled }: { o: AdminOverview; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Default (:{o.defaultPort}) — same address as yours</option>
      {o.ports.map((p) => (
        <option key={p.port} value={String(p.port)}>
          :{p.port}
          {p.origin ? ` — ${p.origin}` : ''}
        </option>
      ))}
    </select>
  );
}

function ResetModal({ o, user, onClose, onDone }: { o: AdminOverview; user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<ResetMode>('recovery');
  const [adminPassword, setAdminPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const claimed = user.status === 'active' || user.status === 'reset';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.adminResetUser(user.id, { mode, ...(custom ? { password: custom } : {}), adminPassword, ...(totp ? { totp: totp.trim() } : {}) });
      setResult(r.temporaryPassword);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    return (
      <Modal title="Password reset" onClose={onClose}>
        <TempPassword value={result} who={user.username} url={signInUrl(o, user.port)} />
        {claimed && mode === 'recovery' ? <p className="muted small">They also need their recovery key to get back into their existing data.</p> : null}
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </Modal>
    );
  }
  return (
    <Modal title={`Reset ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {claimed ? (
          <fieldset className="radio-group">
            <label className="radio">
              <input type="radio" name="mode" checked={mode === 'recovery'} onChange={() => setMode('recovery')} />
              <span>
                <strong>Forgot the password — keep the data.</strong> They sign in with a temporary password and prove they have their recovery key. Their sessions end now.
              </span>
            </label>
            <label className="radio">
              <input type="radio" name="mode" checked={mode === 'wipe'} onChange={() => setMode('wipe')} />
              <span>
                <strong>Start over — delete everything.</strong> Deletes all their logged messages and media and logs their TikTok out. Use it when they lost the recovery key too.
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="muted">They have not signed in yet. This gives them a new temporary password.</p>
        )}
        <label>
          New temporary password <span className="muted">(leave empty to generate one)</span>
          <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} minLength={12} maxLength={256} autoComplete="off" spellCheck={false} />
        </label>
        <Reauth password={adminPassword} onPassword={setAdminPassword} totp={totp} onTotp={setTotp} />
        <ErrorNote error={error} />
        <div className="row gap">
          <button className={mode === 'wipe' && claimed ? 'btn danger' : 'btn primary'} disabled={busy}>
            {busy ? <Spinner size={18} /> : mode === 'wipe' && claimed ? 'Delete their data and reset' : 'Reset password'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** "4 h 30 min" for a minute count. */
export function humanMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  return h ? `${h} h` : `${m} min`;
}

/** One-line summary of a user's session schedule for the table. */
export function scheduleLine(u: AdminUser): string | null {
  const sc = u.ttSchedule;
  if (!sc || sc.mode === 'on') return null;
  if (sc.mode === 'off') return 'Always off';
  const until = sc.phaseUntil ? ` until ${formatTime(sc.phaseUntil)}` : '';
  return `Scheduled · ${sc.phase === 'on' ? 'on' : 'off'}${until}`;
}

/** Hours + minutes fields for a length in minutes. */
function Duration({ label, minutes, onChange, min = 0 }: { label: string; minutes: number; onChange: (m: number) => void; min?: number }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const set = (nh: number, nm: number) => onChange(Math.max(min, Math.min(10080, nh * 60 + nm)));
  return (
    <div className="row gap">
      <label>
        {label} <span className="muted">hours</span>
        <input type="number" min={0} max={168} value={h} onChange={(e) => set(Math.max(0, Number(e.target.value) || 0), m)} />
      </label>
      <label>
        <span className="muted">minutes</span>
        <input type="number" min={0} max={59} value={m} onChange={(e) => set(h, Math.max(0, Math.min(59, Number(e.target.value) || 0)))} />
      </label>
    </div>
  );
}

function SessionModal({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const cur = user.ttSchedule;
  const [cfg, setCfg] = useState<TtScheduleConfig>({
    mode: cur?.mode ?? 'on',
    offMinutes: cur?.offMinutes ?? 240,
    onMinutes: cur?.onMinutes ?? 20,
    randomize: cur?.randomize ?? false,
    offJitterMinutes: cur?.offJitterMinutes ?? 30,
    onJitterMinutes: cur?.onJitterMinutes ?? 5,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<TtScheduleConfig>) => setCfg((c) => ({ ...c, ...p }));

  const problem =
    cfg.mode !== 'scheduled'
      ? null
      : cfg.offMinutes < 1 || cfg.onMinutes < 1
        ? 'Both times must be at least 1 minute.'
        : cfg.randomize && cfg.offJitterMinutes >= cfg.offMinutes
          ? 'The random range of the off time must be shorter than the off time.'
          : cfg.randomize && cfg.onJitterMinutes >= cfg.onMinutes
            ? 'The random range of the on time must be shorter than the on time.'
            : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adminSetTtSchedule(user.id, cfg);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`TikTok session · ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <fieldset className="radio-group">
          <label className="radio">
            <input type="radio" name="mode" checked={cfg.mode === 'on'} onChange={() => patch({ mode: 'on' })} />
            <span>
              <strong>Always on.</strong> The TikTok session runs all the time and every message is logged.
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={cfg.mode === 'off'} onChange={() => patch({ mode: 'off' })} />
            <span>
              <strong>Always off.</strong> The TikTok browser is shut down (the login is kept). Nothing is logged until you switch it on.
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={cfg.mode === 'scheduled'} onChange={() => patch({ mode: 'scheduled' })} />
            <span>
              <strong>Scheduled.</strong> Off for a while, then on for a while, over and over. It starts with the on time.
            </span>
          </label>
        </fieldset>
        {cfg.mode === 'scheduled' ? (
          <>
            <Duration label="Off for" minutes={cfg.offMinutes} onChange={(m) => patch({ offMinutes: m })} min={1} />
            <Duration label="Then on for" minutes={cfg.onMinutes} onChange={(m) => patch({ onMinutes: m })} min={1} />
            <label className="radio">
              <input type="checkbox" checked={cfg.randomize} onChange={(e) => patch({ randomize: e.target.checked })} />
              <span>
                <strong>Randomize.</strong> Each off and on time is the length above plus or minus a random amount, so the pattern never repeats exactly.
              </span>
            </label>
            {cfg.randomize ? (
              <>
                <label>
                  Off time ± <span className="muted">minutes</span>
                  <input type="number" min={0} max={10079} value={cfg.offJitterMinutes} onChange={(e) => patch({ offJitterMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                </label>
                <label>
                  On time ± <span className="muted">minutes</span>
                  <input type="number" min={0} max={10079} value={cfg.onJitterMinutes} onChange={(e) => patch({ onJitterMinutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                </label>
              </>
            ) : null}
            <p className="muted small">
              {cfg.randomize
                ? `Off for ${humanMinutes(Math.max(1, cfg.offMinutes - cfg.offJitterMinutes))} – ${humanMinutes(cfg.offMinutes + cfg.offJitterMinutes)}, then on for ${humanMinutes(Math.max(1, cfg.onMinutes - cfg.onJitterMinutes))} – ${humanMinutes(cfg.onMinutes + cfg.onJitterMinutes)}.`
                : `Off for ${humanMinutes(cfg.offMinutes)}, then on for ${humanMinutes(cfg.onMinutes)}.`}{' '}
              While it is off nothing is logged; the log catches up when it comes back on (a message unsent during the off time can be missed).
            </p>
          </>
        ) : null}
        {cur && cur.mode !== 'on' ? (
          <p className="muted small">
            Right now: <strong>{cur.phase === 'on' ? 'on' : 'off'}</strong>
            {cur.phaseUntil ? ` until ${formatDateTime(cur.phaseUntil)}` : ''}.
          </p>
        ) : null}
        <ErrorNote error={error ?? problem} />
        <div className="row gap">
          <button className="btn primary" disabled={busy || !!problem}>
            {busy ? <Spinner size={18} /> : 'Save'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.adminDeleteUser(user.id, adminPassword, totp.trim() || undefined);
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Delete ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p>
          This permanently deletes <strong>{user.username}</strong>: every logged message and media file, their keys, and their browser with the TikTok session. It cannot be undone.
        </p>
        <Reauth password={adminPassword} onPassword={setAdminPassword} totp={totp} onTotp={setTotp} />
        <ErrorNote error={error} />
        <div className="row gap">
          <button className="btn danger" disabled={busy}>
            {busy ? <Spinner size={18} /> : 'Delete permanently'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UsersSection({ o, reload }: { o: AdminOverview; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [session, setSession] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const patch = async (u: AdminUser, body: { port?: number | null; disabled?: boolean }) => {
    setBusyId(u.id);
    setError(null);
    try {
      await api.adminUpdateUser(u.id, body);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      title="Users"
      hint="Everyone has an TikTok of their own, separate encrypted data, separate keys and a separate browser. You see names, status and ports — never messages."
    >
      <div className="table-wrap">
        <table className="table users">
          <thead>
            <tr>
              <th>User</th>
              <th>Account</th>
              <th>TikTok</th>
              <th>Port</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {o.users.map((u) => {
              const st = u.disabled ? { label: 'Disabled', tone: 'bad' as const } : STATUS[u.status];
              const me = u.id === o.currentUserId;
              return (
                <tr key={u.id}>
                  <td>
                    <strong>{u.username}</strong> {u.role === 'admin' ? <span className="badge">admin</span> : null} {me ? <span className="muted small">(you)</span> : null}
                  </td>
                  <td>
                    <span className={`pill pill-${st.tone}`}>
                      <span className="dot" />
                      {st.label}
                    </span>
                  </td>
                  <td>
                    {u.tt ? <TtStatePill status={{ state: u.tt, mediaQueue: 0, sync: null, since: 0, lastEventAt: null } as TtStatus} /> : <span className="muted">—</span>}
                    {scheduleLine(u) ? <div className="muted small">{scheduleLine(u)}</div> : null}
                  </td>
                  <td>
                    {u.role === 'admin' ? (
                      <span className="muted">:{o.defaultPort} (default)</span>
                    ) : (
                      <PortSelect o={o} value={u.port === null ? '' : String(u.port)} onChange={(v) => void patch(u, { port: v ? Number(v) : null })} disabled={busyId === u.id} />
                    )}
                  </td>
                  <td className="small">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}</td>
                  <td className="actions">
                    {u.status === 'active' ? (
                      <button className="btn tiny" onClick={() => setSession(u)}>
                        Session…
                      </button>
                    ) : null}
                    {u.role === 'admin' ? null : (
                      <>
                        <button className="btn tiny" disabled={busyId === u.id} onClick={() => void patch(u, { disabled: !u.disabled })}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button className="btn tiny" onClick={() => setResetting(u)}>
                          Reset…
                        </button>
                        <button className="btn tiny danger" onClick={() => setDeleting(u)}>
                          Delete…
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorNote error={error} />
      <p className="muted small">
        Disabling a user ends their sessions and blocks sign-in; their TikTok keeps being logged. {o.users.length} of {o.maxUsers} users.
      </p>
      <button className="btn primary" onClick={() => setAdding(true)} disabled={o.users.length >= o.maxUsers}>
        <Icon name="plus" size={18} /> Add a user
      </button>
      {adding ? (
        <CreateModal
          o={o}
          onClose={() => {
            setAdding(false);
            void reload();
          }}
        />
      ) : null}
      {session ? <SessionModal user={session} onClose={() => setSession(null)} onDone={() => void reload()} /> : null}
      {resetting ? <ResetModal o={o} user={resetting} onClose={() => setResetting(null)} onDone={() => void reload()} /> : null}
      {deleting ? <DeleteModal user={deleting} onClose={() => setDeleting(null)} onDone={() => void reload()} /> : null}
    </Section>
  );
}

function PortsSection({ o, reload }: { o: AdminOverview; reload: () => Promise<void> }) {
  const free = o.availablePorts.filter((p) => !o.ports.some((x) => x.port === p));
  const [port, setPort] = useState('');
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Ports"
      hint={
        <>
          The default port <span className="mono">:{o.defaultPort}</span> is yours — the admin account can only sign in there. A user assigned to another port can only sign in there, so you can put your
          own address behind a login proxy (e.g. authentik) and give a friend a separate address without one. Point a reverse-proxy host at each port you open (the compose file publishes{' '}
          <span className="mono">{o.availablePorts.length ? `${o.availablePorts[0]}–${o.availablePorts[o.availablePorts.length - 1]}` : 'none'}</span>, set by <span className="mono">EXTRA_PORTS</span>).
        </>
      }
    >
      {o.ports.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Address people use</th>
                <th>Users</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {o.ports.map((p) => (
                <PortRow key={p.port} port={p} busy={busy} onSave={(v) => run(() => api.adminPutPort(p.port, v))} onRemove={() => run(() => api.adminDeletePort(p.port))} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No extra port is open yet.</p>
      )}
      {free.length ? (
        <form
          className="row gap wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.adminPutPort(Number(port || free[0]), origin.trim() || null)).then((ok) => ok && setOrigin(''));
          }}
        >
          <select value={port || String(free[0])} onChange={(e) => setPort(e.target.value)}>
            {free.map((p) => (
              <option key={p} value={p}>
                :{p}
              </option>
            ))}
          </select>
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://friend.example.com (optional)" inputMode="url" maxLength={200} className="grow" />
          <button className="btn" disabled={busy}>
            Open port
          </button>
        </form>
      ) : (
        <p className="muted small">All published ports are open.</p>
      )}
      <p className="muted small">
        The address is the exact origin the browser uses on that port; it is checked on every request. Leave it empty to accept the address the proxy forwards.
      </p>
      <ErrorNote error={error} />
    </Section>
  );
}

function PortRow({ port, busy, onSave, onRemove }: { port: AdminOverview['ports'][number]; busy: boolean; onSave: (origin: string | null) => unknown; onRemove: () => unknown }) {
  const [origin, setOrigin] = useState(port.origin ?? '');
  const dirty = (port.origin ?? '') !== origin.trim();
  return (
    <tr>
      <td className="mono">:{port.port}</td>
      <td>
        <input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="derived from the Host header" inputMode="url" maxLength={200} />
      </td>
      <td className="small">{port.usernames.length ? port.usernames.join(', ') : <span className="muted">nobody</span>}</td>
      <td className="actions">
        <button className="btn tiny" disabled={busy || !dirty} onClick={() => void onSave(origin.trim() || null)}>
          Save
        </button>
        <button className="btn tiny" disabled={busy || port.usernames.length > 0} onClick={() => void onRemove()} title={port.usernames.length ? 'Move its users away first' : 'Close this port'}>
          Close
        </button>
      </td>
    </tr>
  );
}

function LogSection() {
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.adminAudit().then(setRows, (e) => setError(errorMessage(e)));
  }, []);
  return (
    <Section title="Admin log">
      <ErrorNote error={error} />
      {!rows ? (
        <Spinner />
      ) : (
        <div className="table-wrap audit">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>By</th>
                <th>User</th>
                <th>IP</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={/fail|bad|deleted|disabled|reset/.test(r.event) ? 'warn-row' : undefined}>
                  <td>{formatDateTime(r.ts)}</td>
                  <td className="mono small">{r.event}</td>
                  <td className="small">{r.actor ?? '—'}</td>
                  <td className="small">{r.target ?? '—'}</td>
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

export function AdminPage() {
  const { state } = useAppState();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setOverview(await api.adminOverview());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, [reload]);

  if (state?.role !== 'admin') {
    return (
      <div className="page">
        <p className="muted">Only the admin can manage users.</p>
      </div>
    );
  }
  return (
    <div className="page settings">
      <header className="page-head">
        <h1>
          <Icon name="group" /> Users
        </h1>
        <p className="muted">Signed in as {state.username} (admin)</p>
      </header>
      <ErrorNote error={error} />
      {!overview ? (
        <Spinner />
      ) : (
        <>
          <UsersSection o={overview} reload={reload} />
          <PortsSection o={overview} reload={reload} />
          <LogSection />
        </>
      )}
    </div>
  );
}
