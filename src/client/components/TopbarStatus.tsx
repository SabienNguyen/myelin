import { Fragment, useEffect, useRef, useState } from 'react';
import { BrainIcon as Brain, UserCircleIcon as UserCircle } from '@phosphor-icons/react';
import { LocalModelGetter } from './LocalModelGetter.js';

type Status = { anki?: 'up' | 'down' | 'backlog'; student?: string; tutor?: string };

const ANKI_LABEL: Record<string, string> = {
  up: 'Anki connected',
  down: 'Anki closed — reviews sync when it opens',
  backlog: 'Anki has a review backlog',
};

/**
 * The tutor model, said in words rather than in a model id.
 *
 * The badge used to read the raw model id, which is an implementation detail of how the harness
 * routes a request — and on a first run it is the second thing in the toolbar, next to the learner's
 * own name. What they actually want to know is which model and whose bill.
 */
export function modelLabel(id: string): { name: string; how: string } {
  const pretty = (m: string) => m
    .replace(/^claude-/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2')     // haiku-4-5 -> haiku 4.5
    .replace(/-(\d+)$/, ' $1')             // sonnet-5   -> sonnet 5
    .replace(/^(.)/, (c) => c.toUpperCase());
  if (id.startsWith('ollama:')) {
    return { name: id.slice('ollama:'.length), how: 'local model via Ollama' };
  }
  // The openai: route needed its own branch, not the Anthropic fallthrough: the badge exists to
  // answer "which model, and whose bill", and it was naming the wrong vendor for every
  // OpenAI-compatible model. The id is shown verbatim too — `pretty()` title-cases and rewrites
  // trailing digits for `claude-sonnet-5`, which turned `openai:gpt-5.6-luna` into
  // `Openai:gpt-5.6-luna`, an id that exists nowhere.
  if (id.startsWith('openai:')) {
    return { name: id.slice('openai:'.length), how: 'OpenAI-compatible endpoint' };
  }
  return { name: pretty(id), how: 'Anthropic API' };
}

export function TopbarStatus() {
  const [status, setStatus] = useState<Status>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/status').then((r) => r.json())
      .then((s) => { if (!cancelled) setStatus(s); }).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return (
    <div className="topbar-status">
      {status.student && <StudentSwitcher current={status.student} onSwitched={(name) => setStatus((s) => ({ ...s, student: name }))} />}
      {status.tutor && (
        <ModelsMenu
          tutor={status.tutor}
          onSaved={(tutor) => setStatus((s) => ({ ...s, tutor }))}
        />
      )}
      {/* 'down' is omitted, not shown greyed: on a first run nobody has Anki installed, and an
          amber badge for a feature the learner never asked for reads as "something is broken".
          A backlog IS worth flagging — that one is about work they have already done. */}
      {/* role=status + aria-label, not title alone: a tooltip on an unfocusable span is invisible
          to the keyboard and unreliable for screen readers, and the dot's COLOR was the only other
          carrier of which state this is. */}
      {status.anki && status.anki !== 'down' && (
        <span
          className={`badge anki-${status.anki}`} title={ANKI_LABEL[status.anki]}
          role="status" aria-label={ANKI_LABEL[status.anki]}
        >
          <span className="statusdot" aria-hidden="true" /> anki
        </span>
      )}
    </div>
  );
}


/**
 * The student badge, grown into a switcher: one vault, several learners, separate evidence —
 * engram has always keyed the student model by id, and this is the surface that lets a
 * household actually use that. Menu lists known students (anyone with a state file) plus a
 * field for a new name; switching takes effect on the next request and persists.
 */
function StudentSwitcher({ current, onSwitched }: { current: string; onSwitched: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [students, setStudents] = useState<string[]>([]);
  const [fresh, setFresh] = useState('');
  const [voice, setVoice] = useState('');
  const [note, setNote] = useState('');
  const rootRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/students').then((r) => r.json())
      .then((d) => setStudents(d.students ?? [])).catch(() => {});
    fetch('/api/voice').then((r) => r.json()).then((d) => setVoice(d.voice ?? '')).catch(() => {});
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Dismissal mirrors AddMaterial and HistoryMenu: Escape closes and returns focus to the
    // trigger — this was the one topbar popup where Escape did nothing.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); badgeRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const switchTo = async (name: string) => {
    const res = await fetch('/api/student', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(d.error ?? 'could not switch'); return; }
    setNote(d.warning ?? '');
    onSwitched(d.current);
    setOpen(false);
    setFresh('');
  };

  return (
    <span className="student-switcher" ref={rootRef}>
      <button
        ref={badgeRef}
        type="button" className="badge student-badge"
        aria-haspopup="dialog" aria-expanded={open}
        aria-label={`student: ${current} — switch student`}
        onClick={() => setOpen((o) => !o)}
      >
        <UserCircle size={14} weight="duotone" /> {current}
      </button>
      {/* A dialog, not a menu — same call AddMaterial makes, and for the same reason: this popup
          holds two text INPUTS (teaching style, new student) alongside the student buttons, and
          ARIA forbids a text field inside role="menu". role="menu" also promised the APG arrow-key
          model (focus into the list on open, roving Up/Down) that HistoryMenu implements and this
          never did — announcing "menu" then trapping a screen-reader user with no roving and inputs
          a menu can't contain. Dialog is what it actually is: open it, Tab through, Escape out. */}
      {open && (
        <span className="student-menu" role="dialog" aria-label="switch student">
          {students.map((s) => (
            <button key={s} type="button" className={s === current ? 'on' : ''}
              onClick={() => (s === current ? setOpen(false) : switchTo(s))}>
              {s}{s === current ? ' \u00b7 current' : ''}
            </button>
          ))}
          {/* Tone is a profile preference, so it lives with the profile: one line the tutor
              honors in HOW it teaches — never in what counts as evidence. */}
          <input
            aria-label="teaching style"
            placeholder="teaching style — e.g. no jargon"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            onBlur={() => { void fetch('/api/voice', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice }) }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <input
            aria-label="new student name"
            placeholder="new student…"
            value={fresh}
            onChange={(e) => setFresh(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && fresh.trim()) void switchTo(fresh.trim()); }}
          />
          {note && <span className="student-note" role="status">{note}</span>}
        </span>
      )}
    </span>
  );
}

const ROLE_ORDER = ['tutor', 'grader', 'quiz_gen', 'card_gen', 'compile'] as const;
type RoleName = typeof ROLE_ORDER[number];
const URL_FIELDS = [
  { key: 'OLLAMA_BASE_URL', label: 'ollama base url', placeholder: 'http://localhost:11434/v1' },
  // Serves OpenRouter, Nous, and a local LiteLLM proxy (http://localhost:4000/v1) alike — the
  // openai: route is one wire format, whoever answers it.
  { key: 'OPENAI_COMPAT_BASE_URL', label: 'openai-compatible base url', placeholder: 'https://openrouter.ai/api/v1' },
] as const;
const KEY_FIELDS = [
  { key: 'OLLAMA_API_KEY', label: 'ollama api key' },
  { key: 'OPENAI_COMPAT_API_KEY', label: 'openai-compatible api key' },
] as const;
type EnvKey = (typeof URL_FIELDS | typeof KEY_FIELDS)[number]['key'];

/** What the endpoints report as installed/served, discovered fresh on every dialog open (GET only —
 * the PUT response carries no `available`, so a save keeps the last discovery). */
type Available = { ollama?: string[]; openaiCompat?: string[] };

type ModelsState = {
  roles: Record<string, { effective: string; saved: string | null }>;
  tutorRails?: boolean;
  env: Record<EnvKey, { value?: string; set?: boolean; shadowed: boolean }>;
  available?: Available;
};

/** The datalist's evergreen suggestions; discovered ids join them, minus duplicates. */
const STATIC_MODEL_IDS = [
  'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5',
  'ollama:qwen2.5-coder:14b', 'openai:deepseek/deepseek-chat', 'openai:gemini/gemini-2.5-flash',
];

/** Discovered models as routable ids: `ollama:<name>` / `openai:<id>`, deduped against the static
 * suggestions (an installed model that IS a static entry must not appear twice). */
export function discoveredModelIds(available: Available): string[] {
  const ids = [
    ...(available.ollama ?? []).map((m) => `ollama:${m}`),
    ...(available.openaiCompat ?? []).map((m) => `openai:${m}`),
  ];
  return ids.filter((v, i) => ids.indexOf(v) === i && !STATIC_MODEL_IDS.includes(v));
}

/** The roles the local preset repoints. compile stays put: it writes the vault, so it keeps the
 * strongest model configured. */
const PRESET_ROLES = ['tutor', 'grader', 'quiz_gen', 'card_gen'] as const;

type UsageTotals = { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
type UsageSummary = { today: Record<string, UsageTotals> };
// 'help' is a ledger role (gap help borrows the tutor model) but not a configurable one, so it
// joins the display order here rather than ROLE_ORDER.
const USAGE_ORDER = [...ROLE_ORDER, 'help'] as const;

/** 41321 -> "41k", 2130 -> "2.1k", 950 -> "950" — dense, badge-scale numbers. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** One dialog line per role with any spend today. Cache traffic rides as the raw read/write
 * figures (the numbers a bill is made of) rather than the derived share it once showed — the
 * share is computable from these, not the other way round. Suffix only when there IS cache
 * traffic: a local model with none keeps its short line. */
export function usageLine(role: string, t: UsageTotals): string {
  const cache = t.cacheRead > 0 || t.cacheWrite > 0
    ? ` · cache ${fmtTokens(t.cacheRead)} read / ${fmtTokens(t.cacheWrite)} write`
    : '';
  return `${role} ${fmtTokens(t.in)} in / ${fmtTokens(t.out)} out${cache}`;
}

/**
 * The tutor badge, grown into the model configuration surface: every role's id and the provider
 * endpoints models.ts reads, editable in place. Saves land in settings.json (GET/PUT
 * /api/setup/models) and take effect on the next call — the server resolves providers per
 * request, so there is no restart. Saved API keys never come back down; the server sends a
 * `set` flag and the password fields show placeholder "saved" instead.
 */
function ModelsMenu({ tutor, onSaved }: { tutor: string; onSaved: (tutor: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roles, setRoles] = useState<Record<RoleName, string>>(Object.fromEntries(ROLE_ORDER.map((r) => [r, ''])) as Record<RoleName, string>);
  const [rails, setRails] = useState(false);
  // What the server reported at load — a save only sends what changed against this.
  const [loaded, setLoaded] = useState<ModelsState | null>(null);
  const [env, setEnv] = useState<Record<EnvKey, string>>({
    OLLAMA_BASE_URL: '', OLLAMA_API_KEY: '', OPENAI_COMPAT_BASE_URL: '', OPENAI_COMPAT_API_KEY: '',
  });
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // The Anthropic key: input stays empty (the value never returns from the server; typing here
  // means "replace it"), meta says whether one exists and whether the environment shadows it.
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicMeta, setAnthropicMeta] = useState<{ present: boolean; source: string | null }>({ present: false, source: null });
  const [available, setAvailable] = useState<Available>({});
  // Which local model the preset row would apply — '' until the user picks, so the first
  // discovered model is the default without an effect syncing state to fetches.
  const [presetPick, setPresetPick] = useState('');
  const rootRef = useRef<HTMLSpanElement>(null);
  const badgeRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  // Where a chip click lands: the role input focused most recently. A ref, not state — chips read
  // it on click and nothing renders from it.
  const lastRole = useRef<RoleName>('tutor');

  const takeState = (d: ModelsState) => {
    setLoaded(d);
    setRoles(Object.fromEntries(ROLE_ORDER.map((r) => [r, d.roles[r]?.effective ?? ''])) as Record<RoleName, string>);
    setRails(Boolean(d.tutorRails));
    if (d.available) setAvailable(d.available);
    // Key inputs stay empty — the value never leaves the server; base URLs are not secrets.
    setEnv((e) => ({
      ...e,
      OLLAMA_BASE_URL: d.env.OLLAMA_BASE_URL.value ?? '',
      OPENAI_COMPAT_BASE_URL: d.env.OPENAI_COMPAT_BASE_URL.value ?? '',
      OLLAMA_API_KEY: '', OPENAI_COMPAT_API_KEY: '',
    }));
  };

  useEffect(() => {
    if (!open) return;
    setNote(null);
    fetch('/api/setup/models').then((r) => r.json()).then(takeState).catch(() => {});
    fetch('/api/usage').then((r) => r.json()).then(setUsage).catch(() => {});
    // The Anthropic key's presence/source lives on the setup state, not the models state — the
    // first-run card writes it, this dialog is where it gets CHANGED afterwards.
    fetch('/api/setup').then((r) => r.json())
      .then((d) => setAnthropicMeta({ present: Boolean(d?.apiKey?.present), source: d?.apiKey?.source ?? null }))
      .catch(() => {});
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); badgeRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => { if (open) firstRef.current?.focus(); }, [open]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const models: Record<string, string> = {};
    for (const r of ROLE_ORDER) {
      const v = roles[r].trim();
      if (v && v !== (loaded?.roles[r]?.effective ?? '')) models[r] = v;
    }
    const envOut: Record<string, string> = {};
    for (const f of URL_FIELDS) {
      const v = env[f.key].trim();
      if (v && !loaded?.env[f.key]?.shadowed && v !== (loaded?.env[f.key]?.value ?? '')) envOut[f.key] = v;
    }
    for (const f of KEY_FIELDS) {
      const v = env[f.key].trim();
      if (v && !loaded?.env[f.key]?.shadowed) envOut[f.key] = v;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/setup/models', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models, env: envOut,
          ...(rails !== Boolean(loaded?.tutorRails) ? { tutorRails: rails } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setNote({ text: d.error ?? 'save failed', err: true }); return; }
      takeState(d as ModelsState);
      // A typed Anthropic key rides the same save press, through the endpoint that VALIDATES it
      // against Anthropic — so a wrong key fails here with its own message, and a key failure
      // after a successful models save says exactly which half went through.
      if (anthropicKey.trim() && anthropicMeta.source !== 'environment') {
        const keyRes = await fetch('/api/setup/api-key', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: anthropicKey.trim() }),
        });
        if (!keyRes.ok) {
          const kd = await keyRes.json().catch(() => ({}));
          setNote({ text: `models saved, but the Anthropic key was rejected: ${(kd as any).error ?? 'invalid key'}`, err: true });
          return;
        }
        setAnthropicKey('');
        setAnthropicMeta({ present: true, source: 'saved' });
      }
      setNote({ text: 'saved — takes effect on the next call', err: false });
      onSaved((d as ModelsState).roles.tutor?.effective ?? tutor);
    } catch (err: any) {
      setNote({ text: `save failed: ${err?.message ?? err}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const { name, how } = modelLabel(tutor);
  const usageRows = USAGE_ORDER.filter((r) => usage?.today?.[r]);
  const localModels = available.ollama ?? [];
  // A stale pick (model uninstalled between opens) falls back to the first discovered model.
  const presetValue = presetPick && localModels.includes(presetPick) ? presetPick : localModels[0];
  const pointPresetAt = (ollamaTag: string) => {
    const id = `ollama:${ollamaTag}`;
    setRoles((s) => ({ ...s, ...Object.fromEntries(PRESET_ROLES.map((r) => [r, id])) }));
    setRails(true);
  };
  const applyPreset = () => pointPresetAt(presetValue);
  // Pull-then-configure: after the getter installs (or on "use it" for an already-installed one),
  // re-read discovery so the model joins the installed list, THEN point the teaching roles at it.
  // Order matters: takeState resets the working role/rails state from the server (which has not
  // been saved yet), so the preset must be applied AFTER the refresh or it would be clobbered
  // straight back to the current saved models.
  const configureLocal = async (ollamaTag: string) => {
    await fetch('/api/setup/models').then((r) => r.json()).then(takeState).catch(() => {});
    pointPresetAt(ollamaTag);
    setNote({ text: `${ollamaTag} ready — press save to use it`, err: false });
  };
  return (
    <span className="models-menu" ref={rootRef}>
      <button
        ref={badgeRef}
        type="button" className="badge model-badge"
        aria-haspopup="dialog" aria-expanded={open}
        title={`Tutor model: ${name}, via ${how} (${tutor})`}
        aria-label={`tutor model: ${name}, via ${how} — configure models`}
        onClick={() => setOpen((o) => !o)}
      >
        <Brain size={14} weight="duotone" /> {name}
      </button>
      {/* A dialog for the same reason StudentSwitcher is one: text inputs cannot live in a menu. */}
      {open && (
        <form className="models-panel" role="dialog" aria-label="models" onSubmit={save}>
          {ROLE_ORDER.map((r, i) => (
            <Fragment key={r}>
              <span className="models-row">
                <label htmlFor={`models-role-${r}`}>{r}</label>
                <input
                  id={`models-role-${r}`} ref={i === 0 ? firstRef : undefined}
                  list="model-id-list" autoComplete="off" spellCheck={false}
                  value={roles[r]}
                  onFocus={() => { lastRole.current = r; }}
                  onChange={(e) => setRoles((s) => ({ ...s, [r]: e.target.value }))}
                />
              </span>
              {r === 'tutor' && (
                <span className="models-row">
                  <label htmlFor="models-tutor-rails">rails</label>
                  <span className="models-rails">
                    <input
                      id="models-tutor-rails" type="checkbox"
                      checked={rails}
                      onChange={(e) => setRails(e.target.checked)}
                    />
                    <span className="models-hint">
                      harness drives, model generates — for small local models
                    </span>
                  </span>
                </span>
              )}
            </Fragment>
          ))}
          <datalist id="model-id-list">
            {STATIC_MODEL_IDS.map((id) => (
              <option
                key={id} value={id}
                label={id === 'openai:gemini/gemini-2.5-flash' ? 'via a LiteLLM proxy on the openai: route' : undefined}
              />
            ))}
            {discoveredModelIds(available).map((id) => <option key={id} value={id} />)}
          </datalist>
          <span className="models-group">get a local model</span>
          <LocalModelGetter installed={localModels} onConfigured={configureLocal} busy={busy} />
          <span className="models-hint">
            downloads through Ollama and points the teaching roles at it. needs Ollama installed and
            running (ollama.com).
          </span>
          {localModels.length > 0 && (
            <>
              <span className="models-chips">
                <span className="models-hint">installed locally:</span>
                {localModels.map((m) => (
                  <button
                    key={m} type="button" className="models-chip"
                    title="fills the last-focused role input"
                    onClick={() => setRoles((s) => ({ ...s, [lastRole.current]: `ollama:${m}` }))}
                  >
                    {m}
                  </button>
                ))}
              </span>
              <span className="models-row">
                <label htmlFor="models-local-preset">local preset</label>
                <span className="models-preset">
                  <select
                    id="models-local-preset" value={presetValue}
                    onChange={(e) => setPresetPick(e.target.value)}
                  >
                    {localModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {/* Terse on purpose: a longer label starved the select of the width the model
                      name needs, and the hint line below already says exactly what apply does. */}
                  <button type="button" onClick={applyPreset}>apply</button>
                </span>
              </span>
              <span className="models-hint">
                sets tutor, grader, quiz_gen, card_gen to it and turns rails on. compile stays put —
                compile writes the vault, keep it on the strongest model you have. save still applies.
              </span>
            </>
          )}
          <span className="models-hint">
            tutor and compile want the strongest model; grader, quiz_gen, card_gen run fine on a
            cheap or local one
          </span>
          <span className="models-group">provider endpoints</span>
          {/* The Anthropic key, changeable after first run (the first-run card only sets it once).
              Same conventions as the other key fields: value never round-trips, typing replaces,
              the environment variable shadows the saved one. */}
          <span className="models-row">
            <label htmlFor="models-anthropic-key">anthropic api key</label>
            <input
              id="models-anthropic-key" type="password" autoComplete="off" spellCheck={false}
              placeholder={anthropicMeta.source === 'environment' ? '' : anthropicMeta.present ? 'saved — type to replace' : 'sk-ant-…'}
              disabled={anthropicMeta.source === 'environment'}
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
            />
            {anthropicMeta.source === 'environment' && (
              <span className="models-shadow-note">overridden by ANTHROPIC_API_KEY in the environment</span>
            )}
          </span>
          {/* Paired per provider: each base url sits directly above its key. */}
          {([URL_FIELDS[0], KEY_FIELDS[0], URL_FIELDS[1], KEY_FIELDS[1]] as const).map((f) => {
            const meta = loaded?.env[f.key];
            const isKey = f.key.endsWith('_API_KEY');
            return (
              <span className="models-row" key={f.key}>
                <label htmlFor={`models-env-${f.key}`}>{f.label}</label>
                <input
                  id={`models-env-${f.key}`}
                  type={isKey ? 'password' : 'text'}
                  autoComplete="off" spellCheck={false}
                  placeholder={isKey ? (meta?.set ? 'saved' : '') : (f as { placeholder?: string }).placeholder}
                  disabled={Boolean(meta?.shadowed)}
                  value={env[f.key]}
                  onChange={(e) => setEnv((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                {meta?.shadowed && (
                  <span className="models-shadow-note">overridden by {f.key} in the environment</span>
                )}
              </span>
            );
          })}
          {/* Read-only spend from the usage ledger — a line per role with any tokens today.
              An empty ledger renders nothing: no data is not worth a heading. */}
          {usageRows.length > 0 && (
            <>
              <span className="models-group">usage today</span>
              {usageRows.map((r) => (
                <span className="models-hint" key={r}>{usageLine(r, usage!.today[r])}</span>
              ))}
            </>
          )}
          <span className="models-foot">
            <button type="submit" disabled={busy}>{busy ? 'saving…' : 'save'}</button>
            {note && (
              <span className={`models-note${note.err ? ' err' : ''}`} role="status">{note.text}</span>
            )}
          </span>
        </form>
      )}
    </span>
  );
}
