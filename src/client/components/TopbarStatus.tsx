import { Fragment, useEffect, useRef, useState } from 'react';
import { BrainIcon as Brain, UserCircleIcon as UserCircle } from '@phosphor-icons/react';
import { LocalModelGetter } from './LocalModelGetter.js';
import { CodexConnectionPanel } from './CodexConnectionPanel.js';
import { useDismissableDialog } from '../lib/useDismissableDialog.js';

type Status = { anki?: 'up' | 'down' | 'backlog'; student?: string; tutor?: string };

const ANKI_LABEL: Record<string, string> = {
  up: 'Anki connected',
  down: 'Anki closed — reviews sync when it opens',
  backlog: 'Anki has a review backlog',
};

const ROUTES: [string, string][] = [
  ['ollama:', 'local model via Ollama'],
  ['oai:', 'OpenAI API'],
  ['openai:', 'OpenAI-compatible endpoint'],
  ['openrouter:', 'OpenRouter'],
  ['groq:', 'Groq'],
];

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
  // The openai: route needed its own entry, not the Anthropic fallthrough: the badge exists to
  // answer "which model, and whose bill", and it was naming the wrong vendor for every
  // OpenAI-compatible model. The id is shown verbatim too — `pretty()` title-cases and rewrites
  // trailing digits for `claude-sonnet-5`, which turned `openai:gpt-5.6-luna` into
  // `Openai:gpt-5.6-luna`, an id that exists nowhere.
  for (const [prefix, how] of ROUTES) {
    // A bare prefix (an older config saved `oai:` with the model field cleared) shows the id
    // rather than an empty badge.
    if (id.startsWith(prefix)) return { name: id.slice(prefix.length).trim() || id, how };
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
  }, [open]);
  useDismissableDialog({ open, rootRef, triggerRef: badgeRef, onClose: () => setOpen(false) });

  const switchTo = async (name: string) => {
    let res: Response;
    try {
      res = await fetch('/api/student', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
    } catch {
      setNote('can’t reach the harness — still the same student');
      return;
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(d.error ?? 'could not switch'); return; }
    // Every panel holds the previous learner's mastery (notebook cards, topic levels, the Stage,
    // the palette), so a switch reloads the app rather than repainting only this badge. A warning
    // stays on screen instead, since a reload would erase it.
    if (!d.warning) { location.reload(); return; }
    setNote(`${d.warning} — reload to see ${d.current}’s progress`);
    onSwitched(d.current);
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

// quiz_gen is deliberately absent. It is a configurable role nothing ever calls — quiz blocks are
// staged by the TUTOR as a block tool, there is no separate quiz model — so offering it here asked
// the learner to choose a model that could not affect anything, and reserved a usage row that never
// filled. The config key is kept (config.ts) so existing settings still load.
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'oai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'openai', label: 'OpenAI-compatible' },
] as const;
type Provider = typeof PROVIDERS[number]['id'];

// Keep the wire/storage format stable. Only known routing prefixes are removed, never a
// model's own suffix (qwen3:8b, vendor/model:free). Pasted legacy routed ids still work.
// 'oai' is checked before 'openai' in the alternation for the same reason models.ts orders its
// prefix checks explicitly — the two cannot actually collide, but a reader should not have to work
// that out.
function splitModel(id: string): { provider: Provider; model: string } {
  const prefix = /^(oai|openrouter|groq|ollama|openai):/.exec(id);
  return prefix
    ? { provider: prefix[1] as Provider, model: id.slice(prefix[0].length) }
    : { provider: 'anthropic', model: id };
}
function routedModel(provider: Provider, model: string): string {
  return provider === 'anthropic' ? model : `${provider}:${model}`;
}

const ROLE_ORDER = ['tutor', 'grader', 'card_gen', 'compile'] as const;
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
  { key: 'OPENROUTER_API_KEY', label: 'openrouter api key' },
  { key: 'GROQ_API_KEY', label: 'groq api key' },
  { key: 'OPENAI_API_KEY', label: 'openai api key' },
] as const;
type EnvKey = (typeof URL_FIELDS | typeof KEY_FIELDS)[number]['key'];

/** What the endpoints report as installed/served, discovered fresh on every dialog open (GET only —
 * the PUT response carries no `available`, so a save keeps the last discovery). */
type Available = { ollama?: string[]; openaiCompat?: string[] };

type ModelsState = {
  roles: Record<string, {
    effective: string; saved: string | null; contextTokens?: number | null;
    // True when settings.json holds this role as a hand-tuned OBJECT (sampler, effort, ...)
    // rather than a bare id. `saved` above is still the whole id contract — this is only a hint
    // that more than that is saved for the role.
    savedHasOverrides?: boolean;
  }>;
  env: Record<EnvKey, { value?: string; set?: boolean; shadowed: boolean }>;
  available?: Available;
};

/** The datalist's evergreen suggestions; discovered ids join them, minus duplicates. */
const STATIC_MODEL_IDS = [
  'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5',
  'ollama:qwen2.5-coder:14b', 'openai:deepseek/deepseek-chat', 'openai:gemini/gemini-2.5-flash',
 'openrouter:openrouter/free', 'groq:openai/gpt-oss-120b', 'groq:llama-3.3-70b-versatile',
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
const PRESET_ROLES = ['tutor', 'grader', 'card_gen'] as const;

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
  // Held as the typed string, not a number: '' is the state "no window declared", which is
  // distinct from any number the field could hold and is what a save sends as null.
  const [windows, setWindows] = useState<Record<RoleName, string>>(Object.fromEntries(ROLE_ORDER.map((r) => [r, ''])) as Record<RoleName, string>);
  // What the server reported at load — a save only sends what changed against this.
  const [loaded, setLoaded] = useState<ModelsState | null>(null);
  const [env, setEnv] = useState<Record<EnvKey, string>>({
    OLLAMA_BASE_URL: '', OLLAMA_API_KEY: '', OPENAI_COMPAT_BASE_URL: '', OPENAI_COMPAT_API_KEY: '',
    OPENROUTER_API_KEY: '', GROQ_API_KEY: '', OPENAI_API_KEY: '',
  });
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  // Set when any of the dialog-open reads fails. Those reads used to end in a bare
  // `.catch(() => {})`: the dialog opened anyway, with `loaded`/`roles`/`anthropicMeta` left at
  // their unpopulated defaults, and Save stayed clickable — pressing it would have diffed the
  // empty local state against nothing and could have wiped roles the server actually had set.
  // While this is true the note stays up and Save is disabled until a reopen reloads cleanly.
  const [loadFailed, setLoadFailed] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // The Anthropic key: input stays empty (the value never returns from the server; typing here
  // means "replace it"), meta says whether one exists and whether the environment shadows it.
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicMeta, setAnthropicMeta] = useState<{ present: boolean; source: string | null }>({ present: false, source: null });
  const [available, setAvailable] = useState<Available>({});
  // Free OpenRouter teaching models, fetched when the dialog opens; '' while loading/absent.
  const [freeModels, setFreeModels] = useState<{ id: string; name: string }[] | null>(null);
  const [catalogError, setCatalogError] = useState('');
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
    setWindows(Object.fromEntries(ROLE_ORDER.map((r) => {
      const t = d.roles[r]?.contextTokens;
      return [r, typeof t === 'number' ? String(t) : ''];
    })) as Record<RoleName, string>);
    if (d.available) setAvailable(d.available);
    // Key inputs stay empty — the value never leaves the server; base URLs are not secrets.
    setEnv((e) => ({
      ...e,
      OLLAMA_BASE_URL: d.env.OLLAMA_BASE_URL.value ?? '',
      OPENAI_COMPAT_BASE_URL: d.env.OPENAI_COMPAT_BASE_URL.value ?? '',
      OLLAMA_API_KEY: '', OPENAI_COMPAT_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '', OPENAI_API_KEY: '',
    }));
  };

  useEffect(() => {
    if (!open) return;
    setNote(null);
    setLoadFailed(false);
    const failed = () => {
      setLoadFailed(true);
      setNote({ text: 'could not load current models — reopen this to retry before saving', err: true });
    };
    fetch('/api/setup/models').then(async (r) => {
      const d = await r.json();
      if (!r.ok || !d?.roles || !d?.env) throw new Error(d?.error ?? `models state returned ${r.status}`);
      takeState(d as ModelsState);
    }).catch(failed);
    fetch('/api/usage').then((r) => r.json()).then(setUsage).catch(failed);
    setFreeModels(null);
    setCatalogError('');
    fetch('/api/setup/openrouter/models').then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Could not load the OpenRouter catalog');
      return d;
    }).then((d) => setFreeModels(d.models ?? [])).catch((err) => {
      setFreeModels([]);
      setCatalogError(`${err.message || 'Could not load the OpenRouter catalog'} — reopen to retry.`);
    });
    // The Anthropic key's presence/source lives on the setup state, not the models state — the
    // first-run card writes it, this dialog is where it gets CHANGED afterwards.
    fetch('/api/setup').then((r) => r.json())
      .then((d) => setAnthropicMeta({ present: Boolean(d?.apiKey?.present), source: d?.apiKey?.source ?? null }))
      .catch(failed);
  }, [open]);
  useDismissableDialog({ open, rootRef, triggerRef: badgeRef, onClose: () => setOpen(false) });

  useEffect(() => { if (open) firstRef.current?.focus(); }, [open]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || loadFailed) return;
    const models: Record<string, string> = {};
    for (const r of ROLE_ORDER) {
      const v = roles[r].trim();
      if (v && v !== (loaded?.roles[r]?.effective ?? '')) models[r] = v;
    }
    // An emptied field sends null — that is how a declared window gets taken back off. No integer
    // check here: the number input's own min/step refuses a fraction or a zero before submit, and
    // the PUT refuses anything that still gets past.
    const contextTokens: Record<string, number | null> = {};
    for (const r of ROLE_ORDER) {
      const typed = windows[r].trim();
      const next = typed === '' ? null : Number(typed);
      if (next !== (loaded?.roles[r]?.contextTokens ?? null)) contextTokens[r] = next;
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
          models, contextTokens, env: envOut,
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
  };
  const applyPreset = () => pointPresetAt(presetValue);
  // Pull-then-configure: after the getter installs (or on "use it" for an already-installed one),
  // re-read discovery so the model joins the installed list, THEN point the teaching roles at it.
  // Order matters: takeState resets the working role state from the server (which has not been
  // saved yet), so the preset must be applied AFTER the refresh or it would be clobbered straight
  // back to the current saved models.
  const configureLocal = async (ollamaTag: string) => {
    const refreshed = await fetch('/api/setup/models').then((r) => r.json()).then((d) => { takeState(d); return true; })
      .catch(() => false);
    pointPresetAt(ollamaTag);
    if (!refreshed) {
      // A failed re-read must not print "ready": the preset was applied to local state only, and
      // `loaded` is still whatever (or nothing) the dialog opened with, so a save now could revert
      // roles the server actually has. Same recovery as any other load failure: reopen to retry.
      setLoadFailed(true);
      setNote({ text: `${ollamaTag} pulled, but reading back current models failed — reopen this dialog before saving`, err: true });
      return;
    }
    setNote({ text: `${ollamaTag} ready — press save to use it`, err: false });
  };
  // One role's rows: its provider and model id, and (under "other roles") its context window. The
  // tutor's model sits at the top of the dialog and its window in the collapsed section, so the
  // two halves render separately.
  const roleRows = (r: RoleName, withContext: boolean, withModel = true) => (
    <>
      {withModel && (
        <>
          <span className="models-row">
            <label htmlFor={`models-provider-${r}`}>{r} provider</label>
            <select
              id={`models-provider-${r}`} value={splitModel(roles[r]).provider}
              onFocus={() => { lastRole.current = r; }}
              onChange={(e) => setRoles((s) => ({ ...s,
                [r]: routedModel(e.target.value as Provider, splitModel(s[r]).model),
              }))}
            >
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </span>
          <span className="models-row">
            <label htmlFor={`models-role-${r}`}>{r}</label>
            <input
              id={`models-role-${r}`} ref={r === 'tutor' ? firstRef : undefined}
              list={`model-id-list-${splitModel(roles[r]).provider}`} autoComplete="off" spellCheck={false}
              value={splitModel(roles[r]).model}
              onFocus={() => { lastRole.current = r; }}
              onChange={(e) => {
                const value = e.target.value;
                setRoles((s) => ({ ...s, [r]: /^(oai|openrouter|groq|ollama|openai):/.test(value.trim())
                  ? value.trim() : routedModel(splitModel(s[r]).provider, value) }));
              }}
            />
            {/* settings.json can hold this role as a hand-tuned object (sampler, effort — see
                settings.ts's RoleObject) instead of a bare id. A save here still only ever
                touches the id (setupRoutes.ts keeps the rest), so this is a note, not a field. */}
            {loaded?.roles[r]?.savedHasOverrides && (
              <span className="models-shadow-note">custom settings saved — editing the id keeps them</span>
            )}
          </span>
        </>
      )}
      {withContext && (
        <span className="models-row">
          <label htmlFor={`models-context-${r}`}>{r} context</label>
          <input
            id={`models-context-${r}`} type="number" min={1} step={1} inputMode="numeric"
            autoComplete="off" placeholder="model default"
            value={windows[r]}
            onFocus={() => { lastRole.current = r; }}
            onChange={(e) => setWindows((s) => ({ ...s, [r]: e.target.value }))}
          />
        </span>
      )}
    </>
  );
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
          {roleRows('tutor', false)}
          {/* Every other role, and every context window, is tuning most learners never need —
              collapsed so the one choice that matters (who teaches) is what the dialog opens on. */}
          <details className="models-advanced">
            <summary>other roles and context windows</summary>
            {/* oai: and openai: read the same brand name but are different routes (models.ts):
                oai:<model> is OpenAI's own Responses API — built-in web search, reasoning alongside
                tools; openai: stays the generic OpenAI-compatible endpoint (LM Studio, LiteLLM, a
                proxy), which needs its own base URL below. */}
            <span className="models-hint">
              oai is OpenAI's own API (built-in web search, e.g. oai:gpt-5.1); OpenAI-compatible is
              any other server that speaks the same wire (LM Studio, LiteLLM, a proxy) and needs a
              base URL.
            </span>
            {roleRows('tutor', true, false)}
            {ROLE_ORDER.filter((r) => r !== 'tutor').map((r) => <Fragment key={r}>{roleRows(r, true)}</Fragment>)}
            {/* The window is the only lever over compaction and the truncation warning, and it
                used to be reachable from harness.config.json alone — a learner on a small-window
                model had no supported way to protect themselves from overflow. */}
            <span className="models-hint">
              context is the model's window in tokens: it sets how much history a turn may carry
              before compaction, and how large a chunk compile sends. blank falls back to the
              built-in defaults — unless harness.config.json declares one, which the file reapplies
              at the next restart.
            </span>
            <span className="models-hint">
              tutor and compile want the strongest model; grader and card_gen run fine on a
              cheap or local one
            </span>
          </details>
          {PROVIDERS.map((p) => (
            <datalist key={p.id} id={`model-id-list-${p.id}`}>
              {[...STATIC_MODEL_IDS, ...discoveredModelIds(available)]
                .map(splitModel).filter((m) => m.provider === p.id)
                .map((m) => <option key={m.model} value={m.model} />)}
            </datalist>
          ))}
          {/* The no-cost on-ramp: every id here is verified zero-priced AND tool-capable by the
              server, so a tutor that needs block tools never lands on a model that can't run them. */}
          <span className="models-group">free models (OpenRouter)</span>
          {freeModels === null && <span className="models-hint">checking the OpenRouter catalog…</span>}
          {catalogError && <span className="models-note err" role="status">{catalogError}</span>}
          <span className="models-hint">Catalog membership does not guarantee account access. Provider restrictions and rate limits still apply; no automatic paid fallback.</span>
          {!catalogError && freeModels?.length === 0 && (
            <span className="models-hint">
              none listed right now — select OpenRouter and enter an exact catalog model id.
              Saves check catalog membership, not account access.
            </span>
          )}
          {freeModels && freeModels.length > 0 && (
            <>
              <span className="models-chips">
                {freeModels.slice(0, 8).map((m) => (
                  <button
                    key={m.id} type="button" className="models-chip"
                    title={`fills the last-focused role input — ${m.name}`}
                    onClick={() => setRoles((s) => ({ ...s, [lastRole.current]: `openrouter:${m.id}` }))}
                  >
                    {m.id.replace(/:free$/, '')}
                  </button>
                ))}
              </span>
              <span className="models-hint">
                zero-cost, tool-capable — a key is required (free tier still needs an account), and
                rate limits are the provider's
              </span>
            </>
          )}
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
                sets tutor, grader, card_gen to it. compile stays put — compile writes the vault,
                keep it on the strongest model you have. save still applies.
              </span>
            </>
          )}
          <CodexConnectionPanel />
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
          {([
            URL_FIELDS[0], KEY_FIELDS[0], URL_FIELDS[1], KEY_FIELDS[1],
            KEY_FIELDS[2], KEY_FIELDS[3], KEY_FIELDS[4],
          ] as const).map((f) => {
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
            <button type="submit" disabled={busy || loadFailed}>{busy ? 'saving…' : 'save'}</button>
            {note && (
              <span className={`models-note${note.err ? ' err' : ''}`} role="status">{note.text}</span>
            )}
          </span>
        </form>
      )}
    </span>
  );
}
