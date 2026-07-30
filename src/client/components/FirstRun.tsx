import { useEffect, useState } from 'react';
import { BookOpenTextIcon as BookOpenText, KeyIcon as Key } from '@phosphor-icons/react';

interface SetupState {
  apiKey: { rolesNeeding: string[]; present: boolean; source: string | null; savedAt: string };
  vault: { path: string; exists: boolean };
  config: { path: string; found: boolean };
  blocked: boolean;
}

/**
 * The whole of first-run setup.
 *
 * Every other setting has a default that works (config.ts), which leaves exactly one question a new
 * user must answer: an Anthropic API key for the model roles that need one. (A fully local
 * `ollama:` config never reaches this card — `blocked` stays false.)
 *
 * A gate, not a dismissible banner. A banner would let someone type a question to a tutor that
 * cannot answer, and the failure would arrive as a lost turn several seconds later.
 */
export function FirstRun({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then(setState)
      // A setup check that itself fails must not black out the app: fall through and let the real
      // failure surface where it happens.
      .catch(() => setState(null));
  }, []);

  async function saveKey() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'That did not work.');
      else setState(data);
    } catch (err: any) {
      setError(`Could not reach the app’s own server (${err?.message ?? err}).`);
    } finally {
      setBusy(false);
    }
  }

  if (!state?.blocked) return <>{children}</>;

  return (
    <div className="firstrun">
      {/* main, not div: this screen replaces the whole app, so it needs its own main landmark —
          axe landmark-one-main/region, caught scanning the setup states. */}
      <main className="firstrun-card">
        <p className="firstrun-mark"><BookOpenText size={18} weight="duotone" /> Myelin</p>
        <h1>Ready when you are</h1>
        {/* One sentence, no paths. The vault location matters eventually and not now — it moved to
            the muted footer, because on the first screenshot of this card four lines of absolute
            path were the first thing the eye landed on and the least useful thing on it. */}
        <p className="firstrun-lede">
          Just one thing: a way to reach Claude. Everything else is set up already.
        </p>

        <form
          className="firstrun-option"
          onSubmit={(e) => { e.preventDefault(); void saveKey(); }}
        >
          <label htmlFor="api-key">
            <Key size={16} weight="duotone" /> Anthropic API key
          </label>
          <div className="firstrun-row">
            <input
              id="api-key" type="password" autoFocus autoComplete="off"
              spellCheck={false} placeholder="sk-ant-…"
              value={key} onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="submit"
              className="firstrun-primary"
              disabled={busy || !key.trim()}
            >
              {busy ? 'Checking…' : 'Save'}
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

        {error && <p className="firstrun-error" role="alert">{error}</p>}

        {/* Where things live, once. Answering "where are my notes" and "where does my key go" is
            worth doing and worth doing quietly. */}
        <p className="firstrun-note firstrun-paths">
          Notes: <code>{state.vault.path}</code>
          {' '}· Key: <code>{state.apiKey.savedAt}</code>, outside your notes
        </p>
      </main>
    </div>
  );
}
