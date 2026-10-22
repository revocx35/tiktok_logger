import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { SessionImport } from '../components/SessionImport';
import { VncViewer } from '../components/VncViewer';
import { ErrorNote, TtStatePill, Spinner } from '../components/ui';
import { useAppState } from '../state/AppState';

export function SetupLinkPage() {
  const { tt, refresh } = useAppState();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = tt?.state ?? 'starting';
  const linked = state === 'ready' || state === 'syncing';

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.completeOnboarding();
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setError(null);
    try {
      await api.ttRestart();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="setup-link">
      <header className="setup-head">
        <div>
          <h1>Log in to TikTok</h1>
          <p className="muted">
            This is the real TikTok website running in a private browser on your server. Log in to it exactly like on a computer.
          </p>
        </div>
        <TtStatePill status={tt} />
      </header>
      <div className="setup-body">
        <div className="setup-side">
          <ol className="steps">
            <li>Click into the TikTok page on the right and type your <b>username</b> and <b>password</b>.</li>
            <li>
              If TikTok asks for a <b>code</b> (two-factor authentication) or to confirm it was you, answer it there too — or approve the
              login in the TikTok app on your phone.
            </li>
            <li>Wait until the status says <b>Connected</b> or <b>Importing history</b>, then press <b>Complete</b>.</li>
            <li className="muted small">
              View-once photos/videos are never logged. Everything else you send or receive from now on is saved, encrypted, even if it is
              later unsent.
            </li>
          </ol>
          {linked ? null : <SessionImport />}
        </div>
        <VncViewer viewOnly={false} className="setup-vnc" />
      </div>
      <footer className="setup-foot">
        <div className="muted small">
          {tt?.detail ?? ''}
          {tt?.sync ? ` · ${tt.sync.chatsDone}/${tt.sync.chatsTotal} chats` : ''}
        </div>
        <ErrorNote error={error} />
        <div className="row gap">
          <button className="btn ghost" onClick={restart} title="Reload TikTok in the background browser">
            <Icon name="refresh" size={18} /> Restart
          </button>
          <button className="btn primary" disabled={!linked || busy} onClick={complete}>
            {busy ? <Spinner size={18} /> : linked ? 'Complete' : 'Waiting for TikTok…'}
          </button>
        </div>
      </footer>
    </div>
  );
}
