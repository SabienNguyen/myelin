import { useEffect, useState, type ReactNode } from 'react';

type Status = { connected: boolean; plan: string | null; error?: string };
type Login = { url: string; code: string };
const ROOT = '/api/setup/codex';
const POLL_MS = 2500;

// One phase instead of separate status/login flags: those let "Connected · plus" render beside
// "Waiting for authorization…" with only a Cancel button, which disconnected the new account.
type Phase =
  | { kind: 'checking' }
  | { kind: 'not-connected' }
  | { kind: 'pending'; login: Login; note?: string }
  | { kind: 'connected'; plan: string | null }
  | { kind: 'failed'; message: string };

async function request<T>(fallback: string, path = ROOT, method?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, method ? { method } : undefined);
  } catch {
    throw new Error('Can’t reach the harness. Check that the server is running.');
  }
  const body = await res.json().catch(() => null);
  // codexRoutes.ts answers each failure with its own {error}; the fallback covers bodies without one.
  if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : fallback);
  return body as T;
}

const checkStatus = () => request<Status>('Could not check ChatGPT sign-in. Use Refresh status to retry.');

/** A status read settles a pending sign-in only when it succeeded or failed; otherwise the device
 *  code is still waiting for the learner. */
function afterStatus(prev: Phase, s: Status): Phase {
  if (s.connected) return { kind: 'connected', plan: s.plan };
  if (s.error) return { kind: 'failed', message: s.error };
  return prev.kind === 'pending' ? { kind: 'pending', login: prev.login } : { kind: 'not-connected' };
}

/** Auth setup only: never submits model settings or claims that signing in routes the tutor. */
export function CodexConnectionPanel() {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  // An action that failed (sign-in start, disconnect) without changing the connection itself.
  const [note, setNote] = useState('');
  const pending = phase.kind === 'pending';

  useEffect(() => {
    let active = true;
    checkStatus().then(
      (s) => { if (active) setPhase((p) => afterStatus(p, s)); },
      (e: Error) => { if (active) setPhase({ kind: 'failed', message: e.message }); },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await checkStatus();
        if (active) setPhase((p) => afterStatus(p, s));
      } catch (e) {
        // A backend blip mid sign-in must not end the wait: the device code is still valid.
        if (active) setPhase((p) => (p.kind === 'pending' ? { ...p, note: `${(e as Error).message} Still waiting.` } : p));
      }
      if (active) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [pending]);

  const act = async (kind: 'login' | 'disconnect' | 'refresh') => {
    setBusy(true); setNote('');
    try {
      if (kind === 'login') {
        const login = await request<Login>('Could not start ChatGPT sign-in. Try again.', `${ROOT}/login`, 'POST');
        setPhase({ kind: 'pending', login });
      } else if (kind === 'disconnect') {
        await request('Could not disconnect ChatGPT. Try again.', ROOT, 'DELETE');
        setPhase({ kind: 'not-connected' });
      } else {
        const s = await checkStatus();
        setPhase((p) => afterStatus(p, s));
      }
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = <button type="button" className="models-chip" disabled={busy} onClick={() => void act('login')}>Sign in with ChatGPT</button>;
  const disconnect = (label: string) => <button type="button" className="models-chip" disabled={busy} onClick={() => void act('disconnect')}>{label}</button>;
  let summary: string;
  let control: ReactNode = null;
  switch (phase.kind) {
    case 'checking': summary = 'Checking connection…'; break;
    case 'not-connected': summary = 'Not connected'; control = signIn; break;
    case 'failed': summary = 'Not connected'; control = signIn; break;
    case 'pending': summary = 'Not connected'; control = disconnect('Cancel sign-in'); break;
    case 'connected': summary = `Connected${phase.plan ? ` · ${phase.plan}` : ''}`; control = disconnect('Disconnect ChatGPT'); break;
  }
  const alert = note || (phase.kind === 'failed' ? phase.message : phase.kind === 'pending' ? phase.note : '');

  return <section aria-label="ChatGPT subscription connection">
    <span className="models-group">ChatGPT subscription · preview</span>
    <p className="models-hint">Sign-in setup only. Chat routing is not enabled yet; your current models stay unchanged.</p>
    <p className="models-hint">{summary}</p>
    <span className="models-chips">
      {control}
      <button type="button" className="models-chip" disabled={busy} onClick={() => void act('refresh')}>Refresh status</button>
    </span>
    {phase.kind === 'pending' && <p className="models-hint"><a href={phase.login.url} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a> and enter <code>{phase.login.code}</code>. Waiting for authorization…</p>}
    {alert && <p className="models-note err" role="alert">{alert}</p>}
  </section>;
}
