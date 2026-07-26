import { useEffect, useState } from 'react';
import { KeyIcon as Key } from '@phosphor-icons/react';

interface SetupState {
  apiKey: { rolesNeeding: string[]; present: boolean; source: string | null; savedAt: string };
  vault: { path: string; exists: boolean };
  config: { path: string; found: boolean };
  blocked: boolean;
}

/**
 * The whole of first-run setup.
 *
 * Every other setting now has a default that works (config.ts), which leaves exactly one thing a
 * new user must supply and no amount of defaulting can invent: an API key. So this is a gate, not a
 * settings screen — it renders in place of the app when, and only when, `blocked` is true, because
 * without a key there is no lesson to gate access to.
 *
 * Deliberately not a dismissible banner. A banner would let someone start typing to a tutor that
 * cannot answer, and the failure would arrive as a lost turn several seconds later.
 */
export function FirstRun({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then(setState)
      // A setup check that itself fails must not black out the app: fall through to the app and let
      // the real failure surface where it happens.
      .catch(() => setState(null));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Could not save that key.');
      else setState(data);
    } catch (err: any) {
      setError(`Could not reach the app’s own server (${err?.message ?? err}).`);
    } finally {
      setSaving(false);
    }
  }

  if (!state?.blocked) return <>{children}</>;

  const roles = state.apiKey.rolesNeeding;
  return (
    <div className="firstrun">
      <form className="firstrun-card" onSubmit={save}>
        <h1><Key size={22} weight="duotone" /> One thing left</h1>
        <p>
          Loreweaver needs an Anthropic API key to think. Everything else is already set up — your
          vault is at <code>{state.vault.path}</code>, and you can change any of it later.
        </p>
        <label htmlFor="api-key">Anthropic API key</label>
        <input
          id="api-key" type="password" autoFocus autoComplete="off" spellCheck={false}
          placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)}
        />
        {error && <p className="firstrun-error" role="alert">{error}</p>}
        <button type="submit" disabled={saving || !key.trim()}>
          {saving ? 'Checking…' : 'Save and start'}
        </button>
        <p className="firstrun-note">
          Checked against Anthropic before it is saved, so a wrong key fails here rather than in the
          middle of a lesson. Stored at <code>{state.apiKey.savedAt}</code> — outside your vault, so
          syncing or backing up your notes never carries the key with them. Get one at{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            console.anthropic.com
          </a>.
          {roles.length > 0 && ` Needed by: ${roles.join(', ')}.`}
        </p>
      </form>
    </div>
  );
}
