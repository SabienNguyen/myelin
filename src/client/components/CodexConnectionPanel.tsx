import { useEffect, useState } from 'react';

type Status = { connected: boolean; plan: string | null; error?: string };
type Login = { url: string; code: string };
const ROOT = '/api/setup/codex';

async function request<T>(path = ROOT, method?: string): Promise<T> {
  const res = await fetch(path, method ? { method } : undefined);
  if (!res.ok) throw new Error('Could not reach the ChatGPT connection. Check the server and retry.');
  return res.json() as Promise<T>;
}

/** Auth setup only: never submits model settings or claims that signing in routes the tutor. */
export function CodexConnectionPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<Status>();
        if (!active) return;
        setStatus(next);
        setError(next.error ?? '');
        if (next.connected || next.error) setLogin(null);
        else if (login) timer = setTimeout(poll, 2500);
      } catch {
        if (active) setError('Could not check ChatGPT sign-in. Use Refresh status to retry.');
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [login]);

  const act = async (kind: 'login' | 'disconnect' | 'refresh') => {
    setBusy(true); setError('');
    try {
      if (kind === 'login') setLogin(await request<Login>(`${ROOT}/login`, 'POST'));
      else {
        if (kind === 'disconnect') { await request(ROOT, 'DELETE'); setLogin(null); }
        setStatus(await request<Status>());
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Connection failed. Try again.'); }
    finally { setBusy(false); }
  };

  return <section aria-label="ChatGPT subscription connection">
    <span className="models-group">ChatGPT subscription · preview</span>
    <p className="models-hint">Sign-in setup only. Chat routing is not enabled yet; your current models stay unchanged.</p>
    <p className="models-hint">{status ? status.connected ? `Connected${status.plan ? ` · ${status.plan}` : ''}` : 'Not connected' : 'Checking connection…'}</p>
    <span className="models-chips">
      {!status?.connected && !login && <button type="button" className="models-chip" disabled={busy} onClick={() => void act('login')}>Sign in with ChatGPT</button>}
      {(status?.connected || login) && <button type="button" className="models-chip" disabled={busy} onClick={() => void act('disconnect')}>{login ? 'Cancel sign-in' : 'Disconnect ChatGPT'}</button>}
      <button type="button" className="models-chip" disabled={busy} onClick={() => void act('refresh')}>Refresh status</button>
    </span>
    {login && <p className="models-hint"><a href={login.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a> and enter <code>{login.code}</code>. Waiting for authorization…</p>}
    {error && <p className="models-note err" role="alert">{error}</p>}
  </section>;
}
