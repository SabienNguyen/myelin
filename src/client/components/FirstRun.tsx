import { useEffect, useState } from 'react';
import { BookOpenTextIcon as BookOpenText, KeyIcon as Key, SparkleIcon as Sparkle } from '@phosphor-icons/react';

interface SetupState {
  route: 'api-key' | 'subscription' | null;
  apiKey: { rolesNeeding: string[]; present: boolean; source: string | null; savedAt: string };
  subscription: { cliFound: boolean; cliVersion?: string; loggedIn: boolean; email?: string };
  vault: { path: string; exists: boolean };
  config: { path: string; found: boolean };
  blocked: boolean;
}

/**
 * The whole of first-run setup.
 *
 * Every other setting has a default that works (config.ts), which leaves exactly one question a new
 * user must answer: how this gets paid for. There are two honest answers, and the ordering below is
 * the entire design — if there is already a Claude login on this machine, that is one click and no
 * typing, so it goes first and the key becomes the fallback. Pasting an API key is the most annoying
 * step in setting up any local AI app, and for a lot of people it is avoidable.
 *
 * A gate, not a dismissible banner. A banner would let someone type a question to a tutor that
 * cannot answer, and the failure would arrive as a lost turn several seconds later.
 */
export function FirstRun({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'subscription' | 'key' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only relevant when a subscription is available: the key form starts collapsed so the recommended
  // path is not competing with a text field for attention.
  const [showKeyForm, setShowKeyForm] = useState(false);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then(setState)
      // A setup check that itself fails must not black out the app: fall through and let the real
      // failure surface where it happens.
      .catch(() => setState(null));
  }, []);

  async function send(path: string, body: unknown, which: 'subscription' | 'key') {
    setBusy(which);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'That did not work.');
      else {
        setState(data);
        // A success that leaves the app blocked would re-render this card unchanged — a click
        // that visibly does nothing. Should be unreachable now that applyRoute reroutes explicit
        // Anthropic models too; if a future change reopens the gap, at least say so.
        if (data.blocked) setError('That worked, but something still blocks lessons — these roles still need an API key: ' + (data.apiKey?.rolesNeeding ?? []).join(', ') + '.');
      }
    } catch (err: any) {
      setError(`Could not reach the app’s own server (${err?.message ?? err}).`);
    } finally {
      setBusy(null);
    }
  }

  if (!state?.blocked) return <>{children}</>;

  const sub = state.subscription;
  const canSubscribe = sub.cliFound && sub.loggedIn;
  // With no subscription available there is only one path, so don't make the learner open a panel to
  // reach it.
  const keyFormOpen = showKeyForm || !canSubscribe;

  return (
    <div className="firstrun">
      <div className="firstrun-card">
        <p className="firstrun-mark"><BookOpenText size={18} weight="duotone" /> Loreweaver</p>
        <h1>Ready when you are</h1>
        {/* One sentence, no paths. The vault location matters eventually and not now — it moved to
            the muted footer, because on the first screenshot of this card four lines of absolute
            path were the first thing the eye landed on and the least useful thing on it. */}
        <p className="firstrun-lede">
          Just one thing: a way to reach Claude. Everything else is set up already.
        </p>

        {canSubscribe && (
          <div className="firstrun-option">
            <button
              type="button" className="firstrun-primary"
              disabled={busy !== null}
              onClick={() => send('/api/setup/subscription', {}, 'subscription')}
            >
              <Sparkle size={18} weight="duotone" />
              {busy === 'subscription' ? 'Signing in…' : 'Use my Claude subscription'}
            </button>
            <p className="firstrun-note">
              {sub.email
                ? <>Already signed in on this computer as <strong>{sub.email}</strong>. </>
                : <>Claude Code is signed in on this computer. </>}
              No key to paste, billed to your Claude plan instead of per token.
            </p>
          </div>
        )}

        {canSubscribe && !keyFormOpen && (
          <button type="button" className="firstrun-link" onClick={() => setShowKeyForm(true)}>
            Use an API key instead
          </button>
        )}

        {keyFormOpen && (
          <form
            className="firstrun-option"
            onSubmit={(e) => { e.preventDefault(); send('/api/setup/api-key', { key }, 'key'); }}
          >
            <label htmlFor="api-key">
              <Key size={16} weight="duotone" /> Anthropic API key
            </label>
            <div className="firstrun-row">
              <input
                id="api-key" type="password" autoFocus={!canSubscribe} autoComplete="off"
                spellCheck={false} placeholder="sk-ant-…"
                value={key} onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="submit"
                className={canSubscribe ? undefined : 'firstrun-primary'}
                disabled={busy !== null || !key.trim()}
              >
                {busy === 'key' ? 'Checking…' : 'Save'}
              </button>
            </div>
            {/* Its own line, not buried at the end of the reassurance paragraph. Someone who has
                not got a key yet is the most common first-run visitor, and in the first version this
                was the last four words of a dense grey block. */}
            <p className="firstrun-getkey">
              Don’t have one?{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                Create a key at console.anthropic.com
              </a>
            </p>
            <p className="firstrun-note">
              Checked with Anthropic before it is saved, so a wrong key fails here rather than mid-lesson.
            </p>
          </form>
        )}

        {error && <p className="firstrun-error" role="alert">{error}</p>}

        {!canSubscribe && sub.cliFound && !sub.loggedIn && (
          <p className="firstrun-note firstrun-hint">
            You have Claude Code installed but not signed in. Run <code>claude</code> in a terminal
            once and reopen this app to use your subscription instead of a key.
          </p>
        )}

        {/* Where things live, once. Answering "where are my notes" and "where does my key go" is
            worth doing and worth doing quietly. */}
        <p className="firstrun-note firstrun-paths">
          Notes: <code>{state.vault.path}</code>
          {keyFormOpen && <> · Key: <code>{state.apiKey.savedAt}</code>, outside your notes</>}
        </p>
      </div>
    </div>
  );
}
