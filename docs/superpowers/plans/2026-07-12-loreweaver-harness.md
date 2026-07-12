# Loreweaver Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost tutoring web app over the Loreweaver MCP server: chat tutor with subject blocks (math/writing/quiz), mastery DAG panel, evidence guardrail, review notifications, and two-way Anki sync.

**Architecture:** Single npm package, three source roots: `src/server` (Hono + AI SDK v7 agent loop, spawns Loreweaver over stdio MCP), `src/client` (Vite + React + assistant-ui), `src/shared` (zod schemas both sides import). The Loreweaver MCP server is the only writer of vault/student files; the harness's one read-only exception is globbing `pages/**/*.md` filenames to enumerate slugs (no markdown parsing).

**Tech Stack:** TypeScript, Hono, `ai@7`, `@ai-sdk/anthropic@4`, `@ai-sdk/mcp@2`, `@ai-sdk/react@4`, `@assistant-ui/react@0.14` (+ react-ai-sdk, react-markdown), Vite, MathLive, KaTeX, mathjs, dagre, node-cron, zod, vitest, Playwright.

## Global Constraints

- Node >= 22. ESM only (`"type": "module"`).
- Spec: `docs/superpowers/specs/2026-07-12-loreweaver-harness-design.md`. Read it before your task.
- Loreweaver repo at `~/Dev/personal/loreweaver` is a **dependency — never modify it**.
- **Single-writer rule:** all vault/student mutations go through Loreweaver MCP tools. Harness never writes under the vault except `vault/.harness/**`. Only vault read allowed: glob `pages/**/*.md` for slugs.
- **No hardcoded model ids in code.** Models come from `harness.config.json` roles (`tutor`, `grader`, `quiz_gen`, `card_gen`, `compile`).
- Use canonical AI SDK v7 names, never deprecated aliases: `instructions` (not `system` on agents), `isStepCount` (not `stepCountIs`), `addToolOutput` (not `addToolResult`), `createUIMessageStreamResponse` (not `result.toUIMessageStreamResponse()`), `defineToolkit` (not `makeAssistantToolUI`). `convertToModelMessages` is **async — await it**.
- MCP stdio transport import is exactly: `import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'` (docs prose says a different name; this is what the package exports).
- `@assistant-ui/react-ai-sdk` bundles its own `ai@6` internally — never import `UIMessage`/types from inside it; always from `ai`.
- Loreweaver constants duplicated here (documented divergence risk): `DECAY = { masteredDays: 45, practicingDays: 21 }`, `MasteryLevel = 'unseen'|'exposed'|'practicing'|'mastered'`, `EvidenceKind` includes `'struggled'`.
- Anki evidence ceiling: sync maps success → kind `'exposed'` (maintains decay, never promotes), lapse → `'struggled'`. Never `applied-correctly`/`explained-correctly` from Anki.
- TDD every task: failing test → minimal code → pass → commit. Run `npx tsc --noEmit` before each commit.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Scaffold, shared schemas, config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `harness.config.example.json`
- Create: `src/shared/loreweaver.ts`, `src/shared/blocks.ts`, `src/server/config.ts`
- Test: `tests/config.test.ts`, `tests/blocks.test.ts`

**Interfaces:**
- Produces: `loadConfig(path?): HarnessConfig` (zod-validated; env `HARNESS_CONFIG` overrides path, default `./harness.config.json`); types `HarnessConfig`, `ModelRole`; block schemas `BLOCK_TOOLS` map `{ quick_check, quiz, math_scratchpad, writing_draft }` each `{ input: ZodSchema, result: ZodSchema }`; `DECAY`, `MasteryLevel`, `EvidenceKind`, `PageMasteryDetail` from `src/shared/loreweaver.ts`.

- [ ] **Step 1: Init package + toolchain**

```bash
cd ~/Dev/personal/loreweaver-harness
npm init -y
npm pkg set type=module scripts.test=vitest scripts.typecheck="tsc --noEmit"
npm i ai @ai-sdk/anthropic @ai-sdk/mcp @ai-sdk/react hono @hono/node-server zod node-cron mathjs mathlive katex dagre react react-dom @assistant-ui/react @assistant-ui/react-ai-sdk @assistant-ui/react-markdown remark-gfm
npm i -D typescript tsx vitest @types/node @types/react @types/react-dom @types/dagre vite @vitejs/plugin-react jsdom @testing-library/react @testing-library/user-event @playwright/test
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true,
    "types": ["node", "vite/client"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environmentMatchGlobs: [['tests/client/**', 'jsdom'], ['**', 'node']],
  },
});
```

- [ ] **Step 2: Failing tests for config + block schemas**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/server/config.js';

const valid = {
  vault: '/tmp/vault', student: 'sabien',
  models: {
    tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' },
    quiz_gen: { model: 'claude-sonnet-5' }, card_gen: { model: 'claude-haiku-4-5' },
    compile: { model: 'claude-sonnet-5' },
  },
  loreweaver: { command: 'npx', args: ['tsx', 'server.ts'], embeddings: 'fake' },
  schedule: { digestHour: 9, quietHours: [22, 8], ankiSyncMinutes: 30, ankiBacklogNudgeDays: 3 },
  port: 4820,
};

describe('loadConfig', () => {
  it('loads a valid config and expands ~', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'harness.config.json');
    writeFileSync(p, JSON.stringify({ ...valid, vault: '~/somewhere' }));
    const cfg = loadConfig(p);
    expect(cfg.vault.startsWith('/')).toBe(true);
    expect(cfg.vault.includes('~')).toBe(false);
    expect(cfg.models.tutor.model).toBe('claude-sonnet-5');
  });
  it('fails loud on missing role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lwh-'));
    const p = join(dir, 'bad.json');
    const { grader: _drop, ...restModels } = valid.models;
    writeFileSync(p, JSON.stringify({ ...valid, models: restModels }));
    expect(() => loadConfig(p)).toThrow(/grader/);
  });
});
```

`tests/blocks.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES } from '../src/shared/blocks.js';

describe('block schemas', () => {
  it('exposes exactly the four v1 kinds', () => {
    expect(BLOCK_TOOL_NAMES.sort()).toEqual(['math_scratchpad', 'quick_check', 'quiz', 'writing_draft']);
  });
  it('quick_check round-trips', () => {
    const input = { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' };
    expect(BLOCK_TOOLS.quick_check.input.parse(input)).toEqual(input);
    expect(BLOCK_TOOLS.quick_check.result.parse({ answer: '4' })).toEqual({ answer: '4' });
  });
  it('math_scratchpad requires problemLatex', () => {
    expect(() => BLOCK_TOOLS.math_scratchpad.input.parse({ stepMode: true })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests, verify failure** — `npx vitest run tests/config.test.ts tests/blocks.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement**

`src/shared/loreweaver.ts`:
```ts
// Mirrors ~/Dev/personal/loreweaver/src/types.ts — source of truth lives there.
export type MasteryLevel = 'unseen' | 'exposed' | 'practicing' | 'mastered';
export const LEVELS: MasteryLevel[] = ['unseen', 'exposed', 'practicing', 'mastered'];
export const DECAY = { masteredDays: 45, practicingDays: 21 };
export type EvidenceKind = 'exposed' | 'explained-correctly' | 'applied-correctly' | 'struggled' | 'misconception';
export interface PageMasteryDetail {
  level: MasteryLevel;
  effective: MasteryLevel;
  last_reinforced: string; // ISO yyyy-mm-dd
  evidence: { date: string; kind: EvidenceKind; note: string }[];
  misconceptions: string[];
}
export interface LessonSuggestion {
  slug: string; title: string;
  reason: 'review-due' | 'unmet-prereq' | 'frontier';
  detail: string;
}
```

`src/shared/blocks.ts`:
```ts
import { z } from 'zod';

const quickCheck = {
  input: z.object({
    question: z.string(),
    mode: z.enum(['text', 'choice']),
    choices: z.array(z.string()).optional(),
    expected: z.string().optional(), // exact-match target for mechanical grading
    pageSlug: z.string(),
  }),
  result: z.object({ answer: z.string() }),
};

const quiz = {
  input: z.object({
    title: z.string(),
    items: z.array(z.object({
      id: z.string(),
      type: z.enum(['choice', 'short', 'cloze']),
      prompt: z.string(),
      choices: z.array(z.string()).optional(),
      expected: z.string().optional(),
      pageSlug: z.string(),
    })).min(1),
  }),
  result: z.object({ answers: z.array(z.object({ id: z.string(), answer: z.string() })) }),
};

const mathScratchpad = {
  input: z.object({
    problemLatex: z.string(),
    stepMode: z.boolean(),
    expectedLatex: z.string(), // final answer for numeric-equivalence grading
    variable: z.string().default('x'),
    pageSlug: z.string(),
  }),
  result: z.object({
    steps: z.array(z.object({ latex: z.string() })),
    finalLatex: z.string(),
  }),
};

const writingDraft = {
  input: z.object({
    prompt: z.string(),
    round: z.number().int().min(1),
    priorDraft: z.string().optional(),
    pageSlug: z.string(),
  }),
  result: z.object({ draft: z.string() }),
};

export const BLOCK_TOOLS = {
  quick_check: quickCheck,
  quiz,
  math_scratchpad: mathScratchpad,
  writing_draft: writingDraft,
} as const;
export type BlockToolName = keyof typeof BLOCK_TOOLS;
export const BLOCK_TOOL_NAMES = Object.keys(BLOCK_TOOLS) as BlockToolName[];

export const annotationSchema = z.object({
  annotations: z.array(z.object({
    span: z.string(),           // exact substring of the draft
    category: z.enum(['strong', 'wordy', 'vague', 'structure', 'grammar']),
    note: z.string(),
  })),
  skillGrades: z.record(z.string(), z.enum(['good', 'weak'])), // e.g. {claim: 'good', concision: 'weak'}
});
export type WritingAnnotations = z.infer<typeof annotationSchema>;
```

`src/server/config.ts`:
```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';

const roleSchema = z.object({ model: z.string(), effort: z.enum(['low', 'medium', 'high']).optional() });
const configSchema = z.object({
  vault: z.string(),
  student: z.string(),
  models: z.object({
    tutor: roleSchema, grader: roleSchema, quiz_gen: roleSchema,
    card_gen: roleSchema, compile: roleSchema,
  }),
  loreweaver: z.object({
    command: z.string(),
    args: z.array(z.string()),
    embeddings: z.enum(['ollama', 'fake', 'none']).default('ollama'),
  }),
  schedule: z.object({
    digestHour: z.number().int().min(0).max(23),
    quietHours: z.tuple([z.number(), z.number()]),
    ankiSyncMinutes: z.number().int().positive(),
    ankiBacklogNudgeDays: z.number().int().positive(),
  }),
  port: z.number().int().default(4820),
});
export type HarnessConfig = z.infer<typeof configSchema>;
export type ModelRole = keyof HarnessConfig['models'];

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

export function loadConfig(path = process.env.HARNESS_CONFIG ?? './harness.config.json'): HarnessConfig {
  const raw = JSON.parse(readFileSync(expand(path), 'utf8'));
  const cfg = configSchema.parse(raw); // throws precise zod error at boot — by design
  return { ...cfg, vault: expand(cfg.vault), loreweaver: { ...cfg.loreweaver, args: cfg.loreweaver.args.map(expand) } };
}
```

`harness.config.example.json` — copy the spec §9 JSON exactly (it validates against this schema).

- [ ] **Step 5: Run tests → PASS; typecheck; commit**

```bash
npx vitest run tests/config.test.ts tests/blocks.test.ts && npx tsc --noEmit
git add -A && git commit -m "feat: scaffold, shared block schemas, config loader"
```

---

### Task 2: Loreweaver MCP client + read REST endpoints

**Files:**
- Create: `src/server/mcp.ts`, `src/server/restRoutes.ts`, `src/server/index.ts`
- Test: `tests/mcp.test.ts` (uses the REAL Loreweaver server with a temp vault — same pattern as loreweaver's own `tests/integration.test.ts`)

**Interfaces:**
- Consumes: `loadConfig`, `HarnessConfig` (Task 1).
- Produces: `class Loreweaver` with `static async connect(cfg): Promise<Loreweaver>`; methods `tools(): Promise<ToolSet>` (for the agent), `call(name, args): Promise<any>` (direct call, JSON-parsed from content[0].text; throws on isError), `listSlugs(): Promise<string[]>` (glob, no parsing), `close()`; auto-respawn: if a `call` rejects with a transport error, reconnect once (100ms backoff) and retry the call. Also `buildRestRoutes(lw, cfg): Hono` mounting `GET /api/graph`, `GET /api/page/:slug`, `GET /api/student`, `GET /api/status`.
- `GET /api/graph` returns `{ nodes: [{slug, title, difficulty, status, prereqs, deepens, mastery: PageMasteryDetail|null}], goal: string|null }`.

- [ ] **Step 1: Failing integration test**

`tests/mcp.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loreweaver } from '../src/server/mcp.js';
import type { HarnessConfig } from '../src/server/config.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
let lw: Loreweaver;
let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'derivatives.md'),
    '---\ntitle: Derivatives\ndifficulty: 1\nstatus: solid\n---\nrates of change');
  const cfg = {
    vault, student: 'testkid',
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as HarnessConfig;
  lw = await Loreweaver.connect(cfg);
}, 30_000);

afterAll(async () => { await lw.close(); });

describe('Loreweaver client', () => {
  it('lists slugs by glob without parsing', async () => {
    expect(await lw.listSlugs()).toEqual(['derivatives']);
  });
  it('calls read_page and parses JSON', async () => {
    const page = await lw.call('read_page', { slug: 'derivatives' });
    expect(page.page.meta.title).toBe('Derivatives');
  });
  it('exposes tools for the agent loop', async () => {
    const tools = await lw.tools();
    expect(Object.keys(tools)).toContain('record_evidence');
  });
  it('throws a readable error on isError results', async () => {
    await expect(lw.call('read_page', { slug: 'nope' })).rejects.toThrow();
  });
}, 30_000);
```

- [ ] **Step 2: Run → FAIL** (`Loreweaver` not defined).

- [ ] **Step 3: Implement `src/server/mcp.ts`**

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { glob } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HarnessConfig } from './config.js';

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

export class Loreweaver {
  private constructor(private client: MCPClient, private cfg: HarnessConfig) {}

  static async connect(cfg: HarnessConfig): Promise<Loreweaver> {
    return new Loreweaver(await Loreweaver.spawn(cfg), cfg);
  }

  private static spawn(cfg: HarnessConfig): Promise<MCPClient> {
    return createMCPClient({
      transport: new StdioMCPTransport({
        command: cfg.loreweaver.command,
        args: cfg.loreweaver.args,
        env: {
          ...process.env as Record<string, string>,
          LOREWEAVER_VAULT: cfg.vault,
          LOREWEAVER_EMBEDDINGS: cfg.loreweaver.embeddings,
        },
      }),
      onUncaughtError: (e) => console.error('[loreweaver-mcp]', e),
    });
  }

  tools() { return this.client.tools(); }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const exec = async () => {
      const res = await this.client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
      if (res.isError) throw new Error(`loreweaver ${name}: ${text}`);
      return JSON.parse(text);
    };
    try {
      return await exec();
    } catch (e: any) {
      if (!/closed|EPIPE|transport|disconnected/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 100)); // single respawn with backoff
      this.client = await Loreweaver.spawn(this.cfg);
      return exec();
    }
  }

  async listSlugs(): Promise<string[]> {
    const slugs: string[] = [];
    for await (const f of glob(join(this.cfg.vault, 'pages', '**/*.md'))) {
      slugs.push(basename(f, '.md')); // filenames only — never parse vault markdown here
    }
    return slugs.sort();
  }

  async close() { await this.client.close(); }
}
```

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: REST routes + server entry.** `src/server/restRoutes.ts`:

```ts
import { Hono } from 'hono';
import type { Loreweaver } from './mcp.js';
import type { HarnessConfig } from './config.js';

export function buildRestRoutes(lw: Loreweaver, cfg: HarnessConfig, status: Record<string, string> = {}) {
  const app = new Hono();

  app.get('/api/graph', async (c) => {
    const [slugs, student] = await Promise.all([
      lw.listSlugs(),
      lw.call('get_student_state', { student: cfg.student }),
    ]);
    const nodes = await Promise.all(slugs.map(async (slug) => {
      const { page } = await lw.call('read_page', { slug });
      const detail = await lw.call('get_student_state', { student: cfg.student, slug });
      return {
        slug, title: page.meta.title, difficulty: page.meta.difficulty, status: page.meta.status,
        prereqs: page.meta.prereqs, deepens: page.meta.deepens,
        mastery: detail.detail ?? null,
      };
    }));
    return c.json({ nodes, goal: null, summary: student });
  });

  app.get('/api/page/:slug', async (c) =>
    c.json(await lw.call('read_page', { slug: c.req.param('slug') })));
  app.get('/api/student', async (c) =>
    c.json(await lw.call('get_student_state', { student: cfg.student })));
  app.get('/api/status', (c) => c.json(status));
  return app;
}
```

`src/server/index.ts`:
```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { Loreweaver } from './mcp.js';
import { buildRestRoutes } from './restRoutes.js';

const cfg = loadConfig();
const lw = await Loreweaver.connect(cfg);
const app = new Hono();
app.route('/', buildRestRoutes(lw, cfg));
serve({ fetch: app.fetch, port: cfg.port });
console.log(`loreweaver-harness on :${cfg.port}`);
```

Add a route test to `tests/mcp.test.ts` (same suite, reuses `lw`):
```ts
it('GET /api/graph returns nodes with mastery', async () => {
  const { buildRestRoutes } = await import('../src/server/restRoutes.js');
  const app = buildRestRoutes(lw, { student: 'testkid' } as any);
  const res = await app.request('/api/graph');
  const body = await res.json();
  expect(body.nodes[0].slug).toBe('derivatives');
  expect(body.nodes[0].mastery).toBeNull(); // no evidence yet
});
```

- [ ] **Step 6: Run all → PASS; typecheck; commit** — `git commit -m "feat: loreweaver MCP client with respawn + read REST endpoints"`

---

### Task 3: Model router + prompt assembly

**Files:**
- Create: `src/server/models.ts`, `src/server/prompt.ts`, `src/server/tutor-system-prompt.md`
- Test: `tests/models.test.ts`, `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `HarnessConfig`, `ModelRole` (Task 1); `LessonSuggestion`, `PageMasteryDetail` (Task 1).
- Produces: `modelFor(role: ModelRole, cfg): LanguageModel` (reads `process.env.LW_MOCK_MODEL` — if set, ALL roles return the mock, used by E2E; see Task 12); `cachedSystem(text): SystemModelMessage` (system message object with anthropic ephemeral cacheControl providerOptions); `buildInstructions(): string` (reads tutor-system-prompt.md once); `buildBootstrapContext(args: {mode, state, lessons, reviewsDue, ankiLapses}): string` (the injected first-turn context block); `MODES = ['learn','review','quiz','freeform'] as const`.

- [ ] **Step 1: Failing tests**

`tests/models.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { modelFor, cachedSystem } from '../src/server/models.js';

const cfg = { models: { tutor: { model: 'claude-sonnet-5' }, grader: { model: 'claude-haiku-4-5' } } } as any;

describe('model router', () => {
  it('routes roles to configured ids', () => {
    expect(modelFor('tutor', cfg).modelId).toBe('claude-sonnet-5');
    expect(modelFor('grader', cfg).modelId).toBe('claude-haiku-4-5');
  });
  it('marks system message for anthropic caching', () => {
    const m = cachedSystem('be a tutor');
    expect(m.role).toBe('system');
    expect((m as any).providerOptions.anthropic.cacheControl.type).toBe('ephemeral');
  });
});
```

`tests/prompt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildBootstrapContext, buildInstructions } from '../src/server/prompt.js';

describe('prompt assembly', () => {
  it('instructions include the evidence rule', () => {
    expect(buildInstructions()).toMatch(/record_evidence/);
  });
  it('bootstrap context includes lessons, mode framing, and anki lapses', () => {
    const ctx = buildBootstrapContext({
      mode: 'review',
      state: { 'chain-rule': { level: 'practicing' } },
      lessons: [{ slug: 'derivatives', title: 'Derivatives', reason: 'review-due', detail: 'decayed' }],
      reviewsDue: ['derivatives'],
      ankiLapses: [{ slug: 'chain-rule', count: 3 }],
    });
    expect(ctx).toMatch(/SESSION CONTEXT/);
    expect(ctx).toMatch(/review/i);
    expect(ctx).toMatch(/derivatives/);
    expect(ctx).toMatch(/chain-rule.*3 lapses/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `src/server/models.ts`:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, SystemModelMessage } from 'ai';
import type { HarnessConfig, ModelRole } from './config.js';

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'unset' });

export function modelFor(role: ModelRole, cfg: HarnessConfig): LanguageModel {
  if (process.env.LW_MOCK_MODEL) {
    // E2E hook: Task 12 provides createScriptedModel(); lazily imported to keep prod path clean
    const { createScriptedModel } = require('../../tests/e2e/scripted-model.cjs');
    return createScriptedModel(process.env.LW_MOCK_MODEL);
  }
  return anthropic(cfg.models[role].model);
}

export function cachedSystem(text: string): SystemModelMessage {
  return {
    role: 'system', content: text,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  } as SystemModelMessage;
}
```

`src/server/tutor-system-prompt.md` — port the pedagogy rules from `~/Dev/personal/loreweaver/docs/tutor-prompt.md`, adapted: teach one concept at a time; probe before teaching; use blocks (`quick_check` for quick probes inline, `math_scratchpad`/`writing_draft`/`quiz` for real work); after EVERY graded block result call `record_evidence` (kinds: exposed / explained-correctly / applied-correctly / struggled / misconception+note); mere presentation of a concept ⇒ record `exposed`; never promote from recall alone; prefer `next_lessons` order; use `find_analogies` to bridge from mastered pages.

`src/server/prompt.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODES = ['learn', 'review', 'quiz', 'freeform'] as const;
export type Mode = (typeof MODES)[number];

const here = dirname(fileURLToPath(import.meta.url));
let cached: string | null = null;
export function buildInstructions(): string {
  cached ??= readFileSync(join(here, 'tutor-system-prompt.md'), 'utf8');
  return cached;
}

const FRAMING: Record<Mode, string> = {
  learn: 'Mode: LEARN. Teach the next suggested lesson.',
  review: 'Mode: REVIEW. Re-prove decayed/due pages before anything new.',
  quiz: 'Mode: QUIZ. Open with a quiz block covering recent pages.',
  freeform: 'Mode: FREEFORM. Follow the student; still record evidence.',
};

export function buildBootstrapContext(a: {
  mode: Mode; state: unknown;
  lessons: { slug: string; title: string; reason: string; detail: string }[];
  reviewsDue: string[];
  ankiLapses: { slug: string; count: number }[];
}): string {
  return [
    'SESSION CONTEXT (auto-injected by harness — not visible to the student):',
    FRAMING[a.mode],
    `Student state: ${JSON.stringify(a.state)}`,
    `Suggested lessons: ${a.lessons.map((l) => `${l.slug} (${l.reason}: ${l.detail})`).join('; ') || 'none'}`,
    `Reviews due: ${a.reviewsDue.join(', ') || 'none'}`,
    a.ankiLapses.length
      ? `Anki trouble: ${a.ankiLapses.map((l) => `${l.slug} — ${l.count} lapses this week; probe for misconceptions`).join('; ')}`
      : 'Anki trouble: none',
  ].join('\n');
}
```

- [ ] **Step 4: Tests PASS; typecheck; commit** — `git commit -m "feat: per-role model router with caching + prompt assembly"`

---

### Task 4: Grading module

**Files:**
- Create: `src/server/grading.ts`
- Test: `tests/grading.test.ts`

**Interfaces:**
- Consumes: `BLOCK_TOOLS`, `annotationSchema` (Task 1); `modelFor` (Task 3).
- Produces: `mathEquivalent(aLatex, bLatex, variable): boolean`; `gradeBlockOutput(toolName, input, result, cfg): Promise<Grade>` where `Grade = { verdict: 'correct'|'partial'|'incorrect'|'reviewed', detail: string, perItem?: {id, correct}[], annotations?: WritingAnnotations, evidence: {slug, kind, note}[] }`. Mechanical for choice/exact/math; calls `grader` role (generateText + zod output) only for `short` answers and `writing_draft`.

- [ ] **Step 1: Failing tests** — `tests/grading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mathEquivalent, gradeBlockOutput } from '../src/server/grading.js';

describe('mathEquivalent (numeric sampling)', () => {
  it('accepts algebraically equal forms', () => {
    expect(mathEquivalent('2x', 'x+x', 'x')).toBe(true);
    expect(mathEquivalent('\\frac{1}{2}x', '0.5x', 'x')).toBe(true); // the (1)/(2)x precedence gotcha
    expect(mathEquivalent('\\cos(x^2)\\cdot 2x', '2x\\cos(x^2)', 'x')).toBe(true);
  });
  it('rejects different functions', () => {
    expect(mathEquivalent('x^2', 'x^3', 'x')).toBe(false);
  });
  it('handles ln via rewrite', () => {
    expect(mathEquivalent('\\ln(x)', '\\ln(x)', 'x')).toBe(true);
  });
});

describe('gradeBlockOutput — mechanical paths (no LLM)', () => {
  const cfg = {} as any; // grader role must NOT be called for these
  it('grades quick_check choice', async () => {
    const g = await gradeBlockOutput('quick_check',
      { question: 'q', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
      { answer: '4' }, cfg);
    expect(g.verdict).toBe('correct');
    expect(g.evidence[0]).toMatchObject({ slug: 'arith', kind: 'applied-correctly' });
  });
  it('grades math final answer + flags wrong step', async () => {
    const g = await gradeBlockOutput('math_scratchpad',
      { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' },
      { steps: [{ latex: '2x' }], finalLatex: '2x' }, cfg);
    expect(g.verdict).toBe('correct');
    const bad = await gradeBlockOutput('math_scratchpad',
      { problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' },
      { steps: [{ latex: 'x' }], finalLatex: 'x' }, cfg);
    expect(bad.verdict).toBe('incorrect');
    expect(bad.evidence[0].kind).toBe('struggled');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/server/grading.ts`** (LaTeX pipeline is empirically verified — keep the two regex rewrites):

```ts
import { convertLatexToAsciiMath } from 'mathlive';
import { create, all } from 'mathjs';
import { generateText, Output } from 'ai';
import { annotationSchema, type BlockToolName, type WritingAnnotations } from '../shared/blocks.js';
import type { EvidenceKind } from '../shared/loreweaver.js';
import { modelFor } from './models.js';
import type { HarnessConfig } from './config.js';

const math = create(all);
const SAMPLES = [-2.3, -1, -0.5, 0.7, 1.1, 2, 3.7];

function latexToCompiled(latex: string) {
  const s = convertLatexToAsciiMath(latex)
    .replace(/\bln\s*\(/g, 'log(')
    .replace(/\)\s*(?=[A-Za-z0-9(])/g, ')*'); // fixes (1)/(2)x binding to 1/(2x)
  return math.compile(s);
}

export function mathEquivalent(a: string, b: string, variable = 'x', eps = 1e-9): boolean {
  try {
    const fa = latexToCompiled(a), fb = latexToCompiled(b);
    return SAMPLES.every((x) => {
      let ra: number, rb: number;
      try { ra = fa.evaluate({ [variable]: x }); rb = fb.evaluate({ [variable]: x }); } catch { return true; }
      if (Number.isNaN(ra) && Number.isNaN(rb)) return true;
      return Math.abs(ra - rb) <= eps * Math.max(1, Math.abs(ra), Math.abs(rb));
    });
  } catch { return false; }
}

export interface Grade {
  verdict: 'correct' | 'partial' | 'incorrect' | 'reviewed';
  detail: string;
  perItem?: { id: string; correct: boolean }[];
  annotations?: WritingAnnotations;
  evidence: { slug: string; kind: EvidenceKind; note: string }[];
}

const ev = (slug: string, kind: EvidenceKind, note: string) => ({ slug, kind, note });

export async function gradeBlockOutput(
  tool: BlockToolName, input: any, result: any, cfg: HarnessConfig,
): Promise<Grade> {
  if (tool === 'quick_check') {
    if (input.expected != null) {
      const ok = result.answer.trim().toLowerCase() === input.expected.trim().toLowerCase();
      return {
        verdict: ok ? 'correct' : 'incorrect',
        detail: ok ? 'exact match' : `expected "${input.expected}"`,
        evidence: [ev(input.pageSlug, ok ? 'applied-correctly' : 'struggled', `quick_check: ${input.question}`)],
      };
    }
    return gradeOpenAnswer(input.question, result.answer, input.pageSlug, cfg);
  }

  if (tool === 'math_scratchpad') {
    const finalOk = mathEquivalent(result.finalLatex, input.expectedLatex, input.variable);
    const badStep = input.stepMode
      ? result.steps.findIndex((s: { latex: string }) => !latexParses(s.latex)) : -1;
    return {
      verdict: finalOk ? 'correct' : 'incorrect',
      detail: finalOk ? 'final answer numerically equivalent'
        : `final differs from expected${badStep >= 0 ? `; step ${badStep + 1} unparseable` : ''}`,
      evidence: [ev(input.pageSlug, finalOk ? 'applied-correctly' : 'struggled',
        `math: ${input.problemLatex} → ${result.finalLatex}`)],
    };
  }

  if (tool === 'quiz') {
    const perItem = await Promise.all(input.items.map(async (item: any) => {
      const answer = result.answers.find((a: any) => a.id === item.id)?.answer ?? '';
      if (item.type !== 'short' && item.expected != null)
        return { id: item.id, correct: answer.trim().toLowerCase() === item.expected.trim().toLowerCase() };
      const g = await gradeOpenAnswer(item.prompt, answer, item.pageSlug, cfg);
      return { id: item.id, correct: g.verdict === 'correct' };
    }));
    const right = perItem.filter((p) => p.correct).length;
    const bySlug = new Map<string, { right: number; total: number }>();
    for (const item of input.items) {
      const s = bySlug.get(item.pageSlug) ?? { right: 0, total: 0 };
      s.total++; if (perItem.find((p) => p.id === item.id)?.correct) s.right++;
      bySlug.set(item.pageSlug, s);
    }
    return {
      verdict: right === perItem.length ? 'correct' : right > 0 ? 'partial' : 'incorrect',
      detail: `${right}/${perItem.length}`, perItem,
      evidence: [...bySlug].map(([slug, s]) =>
        ev(slug, s.right === s.total ? 'applied-correctly' : 'struggled', `quiz ${s.right}/${s.total}`)),
    };
  }

  // writing_draft — grader role, structured output
  const { experimental_output } = await generateText({
    model: modelFor('grader', cfg),
    prompt: `Grade this student draft. Prompt: "${input.prompt}"\nDraft:\n${result.draft}\n` +
      `Return annotations whose "span" values are EXACT substrings of the draft, and per-skill grades for: claim, concision, specificity.`,
    experimental_output: Output.object({ schema: annotationSchema }),
  });
  const ann = experimental_output as WritingAnnotations;
  const weak = Object.values(ann.skillGrades).filter((g) => g === 'weak').length;
  return {
    verdict: 'reviewed', detail: `${ann.annotations.length} annotations, ${weak} weak skills`,
    annotations: ann,
    evidence: [ev(input.pageSlug, weak === 0 ? 'applied-correctly' : 'struggled',
      `writing round ${input.round}: skills ${JSON.stringify(ann.skillGrades)}`)],
  };
}

function latexParses(latex: string): boolean {
  try { latexToCompiled(latex); return true; } catch { return false; }
}

async function gradeOpenAnswer(question: string, answer: string, slug: string, cfg: HarnessConfig): Promise<Grade> {
  const { text } = await generateText({
    model: modelFor('grader', cfg),
    prompt: `Question: ${question}\nStudent answer: ${answer}\nReply with exactly CORRECT or INCORRECT followed by a one-line reason.`,
  });
  const ok = /^CORRECT/i.test(text.trim());
  return {
    verdict: ok ? 'correct' : 'incorrect', detail: text.trim(),
    evidence: [ev(slug, ok ? 'explained-correctly' : 'struggled', `open answer: ${question}`)],
  };
}
```

Note: if `Output.object`/`experimental_output` has been renamed in `ai@7.0.x` (it was mid-rename), check `node_modules/ai/dist/index.d.ts` for the structured-output helper on `generateText` and use the canonical one; the schema and flow stay identical.

- [ ] **Step 4: Tests PASS (mechanical tests must not hit the network — they don't reach grader paths); typecheck; commit** — `git commit -m "feat: grading module — numeric math equivalence + grader-role dispatch"`

---

### Task 5: TutorSession, chat route, evidence guardrail, persistence

**Files:**
- Create: `src/server/session.ts`, `src/server/chatRoute.ts`, `src/server/sessionStore.ts`
- Modify: `src/server/index.ts` (mount chat route)
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `Loreweaver` (Task 2), `modelFor`, `cachedSystem`, `buildInstructions`, `buildBootstrapContext`, `Mode` (Task 3), `gradeBlockOutput`, `BLOCK_TOOLS` (Tasks 1/4).
- Produces: `createTutorSession(lw, cfg, opts?): TutorSession` with `respond(messages: UIMessage[], mode: Mode): Promise<Response>` (a `createUIMessageStreamResponse`). Guardrail rule implemented: **if the incoming messages' final assistant/tool exchange contains a block-tool output part and the new generation produces no `record_evidence` tool call, the session appends a system nudge and runs ONE follow-up generation, merged into the same UI stream; a second violation is recorded to `vault/.harness/guardrail.log` and emitted as a transient data part `data-guardrail`.** (The spec's "new concept presented" half of the trigger is prompt-enforced via tutor-system-prompt.md — not mechanically detectable; this narrowing is deliberate and documented here.)
- `sessionStore`: `saveThread(vault, threadId, messages)` / `loadThread(vault, threadId)` — JSON file per thread under `vault/.harness/sessions/<threadId>.json`.
- Chat route: `POST /api/chat` body `{ messages: UIMessage[], mode?: Mode, threadId?: string }`; `GET /api/thread/:id` returns saved messages.

- [ ] **Step 1: Failing tests.** Use a scripted mock model. `ai` ships mock models in `ai/test` (v7 name: `MockLanguageModelV3`; if the local typings differ, open `node_modules/ai/test/dist/index.d.ts` and use the exported `MockLanguageModel*` — only this import line may change).

`tests/session.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { Loreweaver } from '../src/server/mcp.js';
import { createTutorSession } from '../src/server/session.js';

const LW_REPO = `${process.env.HOME}/Dev/personal/loreweaver`;
let lw: Loreweaver; let vault: string;

// Stream chunks for: a text-only reply (no record_evidence) — used to trip the guardrail.
const textOnly = () => new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Nice work!' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ],
    }),
  }),
});

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), 'lwh-vault-'));
  mkdirSync(join(vault, 'pages'), { recursive: true });
  writeFileSync(join(vault, 'pages', 'arith.md'), '---\ntitle: Arithmetic\ndifficulty: 1\nstatus: solid\n---\nnumbers');
  lw = await Loreweaver.connect({
    vault, student: 'kid',
    loreweaver: { command: 'npx', args: ['tsx', join(LW_REPO, 'src/server.ts')], embeddings: 'fake' },
  } as any);
}, 30_000);
afterAll(async () => { await lw.close(); });

// A UIMessage history whose last assistant message contains a completed quick_check tool output.
const blockOutputHistory = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'quiz me' }] },
  {
    id: 'a1', role: 'assistant', parts: [{
      type: 'tool-quick_check', toolCallId: 'tc1', state: 'output-available',
      input: { question: '2+2?', mode: 'choice', choices: ['3', '4'], expected: '4', pageSlug: 'arith' },
      output: { answer: '4' },
    }],
  },
] as any[];

describe('evidence guardrail', () => {
  it('nudges once when block output arrives but no record_evidence is called', async () => {
    const calls: any[] = [];
    const model = textOnly();
    const origDoStream = model.doStream.bind(model);
    (model as any).doStream = async (opts: any) => { calls.push(opts); return origDoStream(opts); };

    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any,
      { model, now: () => new Date('2026-07-12') });
    const res = await session.respond(blockOutputHistory, 'learn');
    await res.text(); // drain the stream

    expect(calls.length).toBe(2); // original + one nudged retry
    const secondPrompt = JSON.stringify(calls[1].prompt);
    expect(secondPrompt).toMatch(/record_evidence/);
    // second violation logged
    expect(existsSync(join(vault, '.harness', 'guardrail.log'))).toBe(true);
    expect(readFileSync(join(vault, '.harness', 'guardrail.log'), 'utf8')).toMatch(/quick_check/);
  }, 30_000);

  it('does not nudge on plain conversation', async () => {
    const calls: any[] = [];
    const model = textOnly();
    const orig = model.doStream.bind(model);
    (model as any).doStream = async (o: any) => { calls.push(o); return orig(o); };
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    const res = await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any, 'learn');
    await res.text();
    expect(calls.length).toBe(1);
  }, 30_000);

  it('injects bootstrap context on first turn', async () => {
    const calls: any[] = [];
    const model = textOnly();
    const orig = model.doStream.bind(model);
    (model as any).doStream = async (o: any) => { calls.push(o); return orig(o); };
    const session = createTutorSession(lw, { student: 'kid', vault, models: {} } as any, { model });
    await (await session.respond([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] as any, 'learn')).text();
    expect(JSON.stringify(calls[0].prompt)).toMatch(/SESSION CONTEXT/);
  }, 30_000);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `src/server/sessionStore.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = (vault: string) => join(vault, '.harness', 'sessions');

export function saveThread(vault: string, threadId: string, messages: unknown[]) {
  mkdirSync(dir(vault), { recursive: true });
  writeFileSync(join(dir(vault), `${threadId}.json`), JSON.stringify(messages));
}
export function loadThread(vault: string, threadId: string): unknown[] {
  const p = join(dir(vault), `${threadId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
}
export function logGuardrail(vault: string, entry: string) {
  mkdirSync(join(vault, '.harness'), { recursive: true });
  appendFileSync(join(vault, '.harness', 'guardrail.log'), `${new Date().toISOString()} ${entry}\n`);
}
```

`src/server/session.ts`:
```ts
import {
  ToolLoopAgent, convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse,
  isStepCount, tool, type LanguageModel, type ModelMessage, type UIMessage,
} from 'ai';
import { z } from 'zod';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES, type BlockToolName } from '../shared/blocks.js';
import type { HarnessConfig } from './config.js';
import { gradeBlockOutput } from './grading.js';
import type { Loreweaver } from './mcp.js';
import { modelFor } from './models.js';
import { buildBootstrapContext, buildInstructions, type Mode } from './prompt.js';
import { logGuardrail } from './sessionStore.js';

// Tools the tutor may use per mode; write/link/compile only in freeform (spec §5).
const TEACH_TOOLS = ['read_page', 'search', 'get_student_state', 'record_evidence',
  'next_lessons', 'find_analogies', 'list_paths', 'read_path'];

function blockTools() {
  // Frontend tools: no execute — the loop pauses; the browser supplies output via addToolOutput.
  return Object.fromEntries(BLOCK_TOOL_NAMES.map((name) => [name, tool({
    description: `Present a ${name} block to the student and wait for their work.`,
    inputSchema: BLOCK_TOOLS[name].input,
  })]));
}

/** Find block-tool outputs in the tail of the incoming history (since the last user text turn). */
function pendingBlockOutputs(messages: UIMessage[]) {
  const out: { tool: BlockToolName; input: any; output: any }[] = [];
  const last = messages[messages.length - 1];
  for (const msg of [last]) {
    if (msg?.role !== 'assistant') continue;
    for (const part of msg.parts as any[]) {
      const name = String(part.type).replace(/^tool-/, '') as BlockToolName;
      if (part.type?.startsWith('tool-') && BLOCK_TOOL_NAMES.includes(name)
        && part.state === 'output-available' && !part.output?.grading) {
        out.push({ tool: name, input: part.input, output: part.output });
      }
    }
  }
  return out;
}

export function createTutorSession(
  lw: Loreweaver, cfg: HarnessConfig,
  opts: { model?: LanguageModel; now?: () => Date } = {},
) {
  const model = opts.model ?? modelFor('tutor', cfg);

  async function bootstrap(mode: Mode): Promise<string> {
    const [state, lessonsRes] = await Promise.all([
      lw.call('get_student_state', { student: cfg.student }),
      lw.call('next_lessons', { student: cfg.student }),
    ]);
    const lessons = lessonsRes.lessons ?? [];
    return buildBootstrapContext({
      mode, state,
      lessons,
      reviewsDue: lessons.filter((l: any) => l.reason === 'review-due').map((l: any) => l.slug),
      ankiLapses: [], // populated by Task 11's lapse query; empty until then
    });
  }

  async function respond(messages: UIMessage[], mode: Mode): Promise<Response> {
    // 1. Grade any fresh block outputs BEFORE the model sees them.
    const pending = pendingBlockOutputs(messages);
    const grades = [];
    for (const p of pending) {
      const grading = await gradeBlockOutput(p.tool, p.input, p.output, cfg);
      p.output.grading = grading; // model sees student work + machine grade together
      grades.push(grading);
    }

    const mcpTools = await lw.tools();
    const activeMcp = Object.fromEntries(Object.entries(mcpTools)
      .filter(([n]) => mode === 'freeform' || TEACH_TOOLS.includes(n)));

    const agent = new ToolLoopAgent({
      model,
      instructions: buildInstructions(),
      tools: { ...activeMcp, ...blockTools() },
      stopWhen: isStepCount(24),
    });

    const isFirstTurn = messages.filter((m) => m.role === 'assistant').length === 0;
    const context: ModelMessage[] = [];
    if (isFirstTurn) context.push({ role: 'user', content: await bootstrap(mode) });
    if (grades.length) context.push({
      role: 'user',
      content: `HARNESS: graded block results attached above: ${grades.map((g) => `${g.verdict} (${g.detail})`).join('; ')}. ` +
        `You MUST now call record_evidence for: ${JSON.stringify(grades.flatMap((g) => g.evidence))} — then respond to the student.`,
    });

    const model_messages = [...context, ...(await convertToModelMessages(messages))];

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const run = async (msgs: ModelMessage[]) => {
          const result = agent.stream({ messages: msgs });
          writer.merge(result.toUIMessageStream());
          const final = await result;
          const called = (await final.steps).flatMap((s: any) => s.toolCalls ?? [])
            .some((tc: any) => tc.toolName === 'record_evidence');
          return called;
        };
        const recorded = await run(model_messages);
        if (grades.length && !recorded) {
          // Guardrail: one nudged retry
          const nudged = await run([...model_messages, {
            role: 'user',
            content: 'HARNESS GUARDRAIL: you did not call record_evidence for the graded block result. Do it now, then continue.',
          }]);
          if (!nudged) {
            logGuardrail(cfg.vault, `unrecorded evidence for ${pending.map((p) => p.tool).join(',')}`);
            writer.write({ type: 'data-guardrail', data: { warning: 'evidence not recorded' }, transient: true } as any);
          }
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  return { respond };
}
export type TutorSession = ReturnType<typeof createTutorSession>;
```

Implementation note for the executor: `agent.stream(...)` result exposes the UI stream — if `result.toUIMessageStream()` does not exist on the agent stream result in your installed `ai@7.0.x`, use the stateless helper: `toUIMessageStream({ stream: result.stream })` imported from `'ai'` (both appear in v7 docs; check `node_modules/ai/dist/index.d.ts` and use whichever exists — this is the only sanctioned deviation).

`src/server/chatRoute.ts`:
```ts
import { Hono } from 'hono';
import type { UIMessage } from 'ai';
import type { HarnessConfig } from './config.js';
import type { Loreweaver } from './mcp.js';
import { createTutorSession } from './session.js';
import { loadThread, saveThread } from './sessionStore.js';
import { MODES, type Mode } from './prompt.js';

export function buildChatRoute(lw: Loreweaver, cfg: HarnessConfig) {
  const app = new Hono();
  const session = createTutorSession(lw, cfg);

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as { messages: UIMessage[]; mode?: Mode; threadId?: string };
    const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'learn';
    const threadId = body.threadId ?? 'default';
    saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
    return session.respond(body.messages, mode);
  });
  app.get('/api/thread/:id', (c) => c.json(loadThread(cfg.vault, c.req.param('id'))));
  app.put('/api/thread/:id', async (c) => {
    saveThread(cfg.vault, c.req.param('id'), await c.req.json());
    return c.json({ ok: true });
  });
  return app;
}
```

In `src/server/index.ts` add: `app.route('/', buildChatRoute(lw, cfg));`

- [ ] **Step 4: Tests PASS; typecheck; commit** — `git commit -m "feat: tutor session with bootstrap ritual, mechanical evidence guardrail, thread persistence"`

---

### Task 6: Frontend shell — runtime, thread UI, markdown wiki-links, Tutor Desk layout

**Files:**
- Create: `index.html`, `vite.config.ts`, `src/client/main.tsx`, `src/client/App.tsx`, `src/client/runtime.tsx`, `src/client/components/Thread.tsx`, `src/client/components/MarkdownText.tsx`, `src/client/components/SidePanel.tsx`, `src/client/components/PagePanel.tsx`, `src/client/lib/api.ts`, `src/client/lib/panelBus.ts`, `src/client/styles.css`
- Test: `tests/client/markdown.test.tsx`, `tests/client/panelBus.test.ts`

**Interfaces:**
- Consumes: REST endpoints (Task 2), `/api/chat` (Task 5).
- Produces: `panelBus` — tiny pub/sub: `openPage(slug)`, `setTab(tab: 'stage'|'graph'|'page')`, `subscribe(fn)`; `wikiPreprocess(md: string): string` converting `[[slug]]` / `[[slug|label]]` → `[label](#/page/slug)`; `<App/>` renders header (mode select, model select, status badges), chat left, `<SidePanel/>` right with three tabs. `StagePanel` arrives in Task 7 — `SidePanel` renders a `stageSlot` placeholder div with id `stage-root` until then.

- [ ] **Step 1: Failing tests**

`tests/client/panelBus.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { panelBus, wikiPreprocess } from '../../src/client/lib/panelBus.js';

describe('panelBus', () => {
  it('notifies subscribers of page opens', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    panelBus.openPage('chain-rule');
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'chain-rule' }]);
  });
});

describe('wikiPreprocess', () => {
  it('rewrites wiki links with and without labels', () => {
    expect(wikiPreprocess('see [[chain-rule]] and [[loss-functions|losses]]'))
      .toBe('see [chain-rule](#/page/chain-rule) and [losses](#/page/loss-functions)');
  });
});
```

`tests/client/markdown.test.tsx` (jsdom):
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WikiLink } from '../../src/client/components/MarkdownText.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

describe('WikiLink', () => {
  it('routes clicks to the panel bus instead of navigating', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    render(<WikiLink href="#/page/derivatives">derivatives</WikiLink>);
    fireEvent.click(screen.getByText('derivatives'));
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'derivatives' }]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `src/client/lib/panelBus.ts`:

```ts
export type PanelEvent =
  | { type: 'openPage'; slug: string }
  | { type: 'setTab'; tab: 'stage' | 'graph' | 'page' }
  | { type: 'teachMe'; slug: string };

type Fn = (e: PanelEvent) => void;
const subs = new Set<Fn>();
export const panelBus = {
  subscribe(fn: Fn) { subs.add(fn); return () => subs.delete(fn); },
  emit(e: PanelEvent) { subs.forEach((f) => f(e)); },
  openPage(slug: string) { this.emit({ type: 'openPage', slug }); },
  setTab(tab: 'stage' | 'graph' | 'page') { this.emit({ type: 'setTab', tab }); },
};

export function wikiPreprocess(md: string): string {
  return md.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g,
    (_, slug, label) => `[${label || slug}](#/page/${slug.trim()})`);
}
```

`src/client/components/MarkdownText.tsx`:
```tsx
import { memo } from 'react';
import { MarkdownTextPrimitive, unstable_memoizeMarkdownComponents as memoize } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { panelBus, wikiPreprocess } from '../lib/panelBus.js';

export function WikiLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const m = props.href?.match(/^#\/page\/(.+)$/);
  if (!m) return <a {...props} target="_blank" rel="noreferrer" />;
  return (
    <a {...props} className="wiki-link" href={props.href}
      onClick={(e) => { e.preventDefault(); panelBus.openPage(m[1]); }} />
  );
}

const components = memoize({ a: WikiLink });
export const MarkdownText = memo(() => (
  <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={components}
    preprocess={wikiPreprocess} defer />
));
```

`src/client/components/Thread.tsx` — minimal hand-rolled thread from primitives (do NOT run `assistant-ui init`; keep it self-contained):
```tsx
import { ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText.js';

export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Messages components={{
          UserMessage: () => (
            <MessagePrimitive.Root className="msg user">
              <MessagePrimitive.Parts />
            </MessagePrimitive.Root>
          ),
          AssistantMessage: () => (
            <MessagePrimitive.Root className="msg assistant">
              <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            </MessagePrimitive.Root>
          ),
        }} />
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Ask your tutor…" />
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
```

`src/client/runtime.tsx`:
```tsx
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import type { PropsWithChildren } from 'react';

export function Runtime({ mode, children }: PropsWithChildren<{ mode: string }>) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: '/api/chat', body: { mode, threadId: 'default' } }),
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
```
(Task 7 extends this file with the block toolkit via `useAui`; keep the provider here.)

`src/client/lib/api.ts`:
```ts
export const getGraph = () => fetch('/api/graph').then((r) => r.json());
export const getPage = (slug: string) => fetch(`/api/page/${slug}`).then((r) => r.json());
export const getStatus = () => fetch('/api/status').then((r) => r.json());
```

`src/client/components/PagePanel.tsx`:
```tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getPage } from '../lib/api.js';
import { WikiLink } from './MarkdownText.js';
import { wikiPreprocess } from '../lib/panelBus.js';

export function PagePanel({ slug }: { slug: string | null }) {
  const [page, setPage] = useState<any>(null);
  useEffect(() => { if (slug) getPage(slug).then(setPage); }, [slug]);
  if (!slug) return <p className="empty">Click a wiki-link or graph node.</p>;
  if (!page) return <p className="empty">Loading…</p>;
  return (
    <article className="page-panel">
      <h2>{page.page.meta.title}</h2>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: WikiLink }}>
        {wikiPreprocess(page.page.body)}
      </ReactMarkdown>
    </article>
  );
}
```
(`react-markdown` is a transitive dep of `@assistant-ui/react-markdown`; add it as a direct dep: `npm i react-markdown`.)

`src/client/components/SidePanel.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { panelBus } from '../lib/panelBus.js';
import { PagePanel } from './PagePanel.js';

export function SidePanel() {
  const [tab, setTab] = useState<'stage' | 'graph' | 'page'>('stage');
  const [pageSlug, setPageSlug] = useState<string | null>(null);
  useEffect(() => panelBus.subscribe((e) => {
    if (e.type === 'openPage') { setPageSlug(e.slug); setTab('page'); }
    if (e.type === 'setTab') setTab(e.tab);
  }), []);
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(['stage', 'graph', 'page'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      <div hidden={tab !== 'stage'} id="stage-root" className="tab-body" />
      <div hidden={tab !== 'graph'} id="graph-root" className="tab-body" />
      <div hidden={tab !== 'page'} className="tab-body"><PagePanel slug={pageSlug} /></div>
    </aside>
  );
}
```

`src/client/App.tsx`:
```tsx
import { useState } from 'react';
import { Runtime } from './runtime.js';
import { Thread } from './components/Thread.js';
import { SidePanel } from './components/SidePanel.js';

export function App() {
  const [mode, setMode] = useState('learn');
  return (
    <Runtime mode={mode}>
      <div className="app">
        <header className="topbar">
          <h1>Loreweaver</h1>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['learn', 'review', 'quiz', 'freeform'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </header>
        <main className="workspace">
          <Thread />
          <SidePanel />
        </main>
      </div>
    </Runtime>
  );
}
```

`src/client/main.tsx`, `index.html`, `vite.config.ts` (proxy `/api` → `http://localhost:4820`), and `styles.css` (grid: header / `1.4fr 1fr` columns; `.wiki-link` underlined; modest, readable defaults — this is a personal tool, not a design showcase). Add scripts: `"dev:server": "tsx src/server/index.ts"`, `"dev:client": "vite"`, `"build": "vite build"`.

- [ ] **Step 4: Tests PASS; `npx vite build` succeeds; typecheck; commit** — `git commit -m "feat: frontend shell — assistant-ui thread, wiki-links, tutor desk layout"`

---

### Task 7: Block toolkit + the four block components

**Files:**
- Create: `src/client/toolkit.tsx`, `src/client/components/blocks/QuickCheck.tsx`, `Quiz.tsx`, `MathScratchpad.tsx`, `WritingDraft.tsx`, `src/client/components/StagePortal.tsx`
- Modify: `src/client/runtime.tsx` (wire `useAui` + `Tools`), `src/client/components/SidePanel.tsx` (StagePortal target)
- Test: `tests/client/quickcheck.test.tsx`, `tests/client/mathscratchpad.test.tsx`, `tests/client/writingdraft.test.tsx`

**Interfaces:**
- Consumes: `BLOCK_TOOLS` schemas (Task 1), `panelBus` (Task 6), assistant-ui `defineToolkit`/`Tools`/`useAui` (type `"human"` — component calls `addResult(result)` exactly once).
- Produces: `toolkit` in `src/client/toolkit.tsx` with all four block tools. Placement rule: `quick_check` renders fully inline in the thread; `quiz`/`math_scratchpad`/`writing_draft` render an inline chip ("Sent to stage ▸") plus their working UI inside `<StagePortal>` (a React portal to `#stage-root` that also fires `panelBus.setTab('stage')` on mount). Each component takes an injectable `MathInput`-style seam where hardware (MathLive web component) is untestable in jsdom.

- [ ] **Step 1: Failing tests**

`tests/client/quickcheck.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuickCheck } from '../../src/client/components/blocks/QuickCheck.js';

describe('QuickCheck', () => {
  it('choice mode: click submits the answer once', () => {
    const addResult = vi.fn();
    render(<QuickCheck args={{ question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' }}
      result={undefined} addResult={addResult} />);
    fireEvent.click(screen.getByRole('button', { name: '4' }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ answer: '4' });
  });
  it('renders grading verdict once result exists', () => {
    render(<QuickCheck args={{ question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' }}
      result={{ answer: '4', grading: { verdict: 'correct', detail: 'exact match' } }} addResult={vi.fn()} />);
    expect(screen.getByText(/correct/i)).toBeTruthy();
  });
});
```

`tests/client/mathscratchpad.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MathScratchpadInner } from '../../src/client/components/blocks/MathScratchpad.js';

// Inject a plain-text stub for the MathLive field (jsdom can't run the web component).
const TextInput = ({ onChange, value }: any) => (
  <input aria-label="math-input" value={value} onChange={(e) => onChange(e.target.value)} />
);

describe('MathScratchpad', () => {
  it('step mode: adds steps then submits steps + final', () => {
    const addResult = vi.fn();
    render(<MathScratchpadInner
      args={{ problemLatex: 'x^2', stepMode: true, expectedLatex: '2x', variable: 'x', pageSlug: 'derivatives' }}
      addResult={addResult} MathInput={TextInput} />);
    fireEvent.change(screen.getByLabelText('math-input'), { target: { value: '2x' } });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ steps: [{ latex: '2x' }], finalLatex: '2x' });
  });
});
```

`tests/client/writingdraft.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WritingDraft } from '../../src/client/components/blocks/WritingDraft.js';

describe('WritingDraft', () => {
  it('submits the draft', () => {
    const addResult = vi.fn();
    render(<WritingDraft args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }} result={undefined} addResult={addResult} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My argument.' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(addResult).toHaveBeenCalledExactlyOnceWith({ draft: 'My argument.' });
  });
  it('renders annotations as highlighted spans', () => {
    render(<WritingDraft args={{ prompt: 'Argue X', round: 1, pageSlug: 'thesis' }}
      result={{ draft: 'A strong claim here.', grading: { verdict: 'reviewed', detail: '', annotations: {
        annotations: [{ span: 'strong claim', category: 'strong', note: 'good' }], skillGrades: { claim: 'good' } } } }}
      addResult={vi.fn()} />);
    expect(screen.getByText('strong claim').className).toMatch(/ann-strong/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `src/client/components/StagePortal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { panelBus } from '../lib/panelBus.js';

export function StagePortal({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById('stage-root'));
    panelBus.setTab('stage');
  }, []);
  return target ? createPortal(children, target) : null;
}
```

`QuickCheck.tsx` (inline, no portal):
```tsx
export function QuickCheck({ args, result, addResult }: {
  args: any; result: any; addResult: (r: any) => void;
}) {
  if (result) {
    return (
      <div className="block quick-check done">
        <p>{args.question}</p>
        <p>You: {result.answer}{result.grading && <em className={`verdict ${result.grading.verdict}`}> — {result.grading.verdict}</em>}</p>
      </div>
    );
  }
  return (
    <div className="block quick-check">
      <p>{args.question}</p>
      {args.mode === 'choice'
        ? args.choices?.map((ch: string) => (
            <button key={ch} onClick={() => addResult({ answer: ch })}>{ch}</button>
          ))
        : <QuickText onSubmit={(answer) => addResult({ answer })} />}
    </div>
  );
}
function QuickText({ onSubmit }: { onSubmit: (v: string) => void }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget).get('a') as string); }}>
      <input name="a" autoFocus /><button type="submit">Answer</button>
    </form>
  );
}
```

`MathScratchpad.tsx` — export `MathScratchpadInner` (testable, `MathInput` injectable) and the default export wrapping it with the real MathLive field + `StagePortal`:
```tsx
import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { StagePortal } from '../StagePortal.js';

export function Latex({ tex }: { tex: string }) {
  return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false }) }} />;
}

function MathLiveInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<any>(null);
  useEffect(() => { import('mathlive'); }, []); // registers <math-field>
  useEffect(() => {
    if (ref.current && ref.current.value !== value)
      ref.current.setValue?.(value, { silenceNotifications: true });
  }, [value]);
  return <math-field ref={ref} onInput={(e: any) => onChange(e.target.value)} />;
}

export function MathScratchpadInner({ args, addResult, MathInput = MathLiveInput }: {
  args: any; addResult: (r: any) => void; MathInput?: typeof MathLiveInput;
}) {
  const [steps, setSteps] = useState<{ latex: string }[]>([]);
  const [current, setCurrent] = useState('');
  return (
    <div className="block math-scratchpad">
      <p>Problem: <Latex tex={args.problemLatex} /></p>
      <ol>{steps.map((s, i) => <li key={i}><Latex tex={s.latex} /></li>)}</ol>
      <MathInput value={current} onChange={setCurrent} />
      {args.stepMode && (
        <button onClick={() => { if (current) { setSteps([...steps, { latex: current }]); setCurrent(''); } }}>
          Add step
        </button>
      )}
      <button onClick={() => {
        const finalLatex = current || steps[steps.length - 1]?.latex || '';
        const allSteps = current ? [...steps, { latex: current }] : steps;
        addResult({ steps: allSteps, finalLatex });
      }}>Submit</button>
    </div>
  );
}

export function MathScratchpad(props: { args: any; result: any; addResult: (r: any) => void }) {
  if (props.result) {
    return <div className="block done">Answer: <Latex tex={props.result.finalLatex} />
      {props.result.grading && <em className={`verdict ${props.result.grading.verdict}`}> — {props.result.grading.detail}</em>}</div>;
  }
  return (
    <>
      <div className="block chip">✏️ Math problem sent to stage ▸</div>
      <StagePortal><MathScratchpadInner args={props.args} addResult={props.addResult} /></StagePortal>
    </>
  );
}
```
Add the React 19 JSX typing for `math-field` in `src/client/mathfield.d.ts`:
```ts
import type { MathfieldElement } from 'mathlive';
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'math-field': React.DetailedHTMLProps<React.HTMLAttributes<MathfieldElement>, MathfieldElement>;
    }
  }
}
```

`WritingDraft.tsx` — textarea when no result; on result, render the draft with `grading.annotations` spans wrapped in `<mark className={'ann-' + category} title={note}>` (walk the draft string, split on each annotation's exact `span` substring, first occurrence wins), plus the skill-grade legend. `Quiz.tsx` — iterate `args.items`, one input per item (buttons for choice, input for short/cloze), local answers state, single Submit calling `addResult({ answers })`; on result with grading, render ✓/✗ per item from `grading.perItem`. Both heavy blocks wrap in `<StagePortal>` with an inline chip, same pattern as MathScratchpad — repeat the pattern, do not import across block files.

`src/client/toolkit.tsx`:
```tsx
import { defineToolkit } from '@assistant-ui/react';
import { BLOCK_TOOLS } from '../shared/blocks.js';
import { QuickCheck } from './components/blocks/QuickCheck.js';
import { Quiz } from './components/blocks/Quiz.js';
import { MathScratchpad } from './components/blocks/MathScratchpad.js';
import { WritingDraft } from './components/blocks/WritingDraft.js';

const human = (name: keyof typeof BLOCK_TOOLS, description: string, Component: any) => ({
  type: 'human' as const,
  description,
  parameters: BLOCK_TOOLS[name].input,
  render: ({ args, result, addResult }: any) =>
    <Component args={args} result={result} addResult={addResult} />,
});

export const toolkit = defineToolkit({
  quick_check: human('quick_check', 'Quick inline probe', QuickCheck),
  quiz: human('quiz', 'Multi-item quiz', Quiz),
  math_scratchpad: human('math_scratchpad', 'Math work with steps', MathScratchpad),
  writing_draft: human('writing_draft', 'Writing exercise with annotations', WritingDraft),
});
```

Wire in `runtime.tsx`: `import { Tools, useAui } from '@assistant-ui/react'`; `const aui = useAui({ tools: Tools({ toolkit }) });` and pass `aui={aui}` to `AssistantRuntimeProvider`.

- [ ] **Step 4: Tests PASS; `npx vite build`; typecheck; commit** — `git commit -m "feat: block toolkit — quick_check, quiz, math scratchpad (MathLive), writing draft"`

---

### Task 8: Graph + mastery panel

**Files:**
- Create: `src/client/lib/graphLayout.ts`, `src/client/components/GraphPanel.tsx`
- Modify: `src/client/components/SidePanel.tsx` (render GraphPanel in graph tab, remove `#graph-root` placeholder)
- Test: `tests/client/graphLayout.test.ts`

**Interfaces:**
- Consumes: `GET /api/graph` node shape (Task 2), `DECAY`, `MasteryLevel` (Task 1), `panelBus` (Task 6), `dagre`.
- Produces: `layoutGraph(nodes, now): { nodes: LaidOutNode[], edges: LaidOutEdge[] }` — pure, testable. `LaidOutNode = { slug, title, x, y, color, ringFraction: number|null, daysLeft: number|null, misconceptions: string[], effective: MasteryLevel }`. Colors: unseen `#9e9e9e`, exposed `#e0b040`, practicing `#5b8def`, mastered `#4caf7d`. `ringFraction` = remaining/total decay window for the *effective* level (null for unseen/exposed). Edges: prereq solid (drawn dst→src bottom-up), deepens dashed.

- [ ] **Step 1: Failing test** — `tests/client/graphLayout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { layoutGraph } from '../../src/client/lib/graphLayout.js';

const nodes = [
  { slug: 'derivatives', title: 'Derivatives', prereqs: [], deepens: [],
    mastery: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-07-05', evidence: [], misconceptions: [] } },
  { slug: 'chain-rule', title: 'Chain Rule', prereqs: ['derivatives'], deepens: [],
    mastery: { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01', evidence: [], misconceptions: ['order confusion'] } },
  { slug: 'jacobians', title: 'Jacobians', prereqs: [], deepens: ['chain-rule'], mastery: null },
];

describe('layoutGraph', () => {
  const g = layoutGraph(nodes as any, new Date('2026-07-12'));
  it('colors by EFFECTIVE level', () => {
    expect(g.nodes.find((n) => n.slug === 'chain-rule')!.color).toBe('#e0b040'); // effective exposed, not stored practicing
  });
  it('computes decay ring for mastered (7 of 45 days elapsed)', () => {
    const d = g.nodes.find((n) => n.slug === 'derivatives')!;
    expect(d.daysLeft).toBe(38);
    expect(d.ringFraction).toBeCloseTo(38 / 45, 2);
  });
  it('positions prereq below dependent (larger y = earlier)', () => {
    const dep = g.nodes.find((n) => n.slug === 'derivatives')!;
    const chain = g.nodes.find((n) => n.slug === 'chain-rule')!;
    expect(dep.y).toBeGreaterThan(chain.y);
  });
  it('null mastery renders unseen gray, no ring', () => {
    const j = g.nodes.find((n) => n.slug === 'jacobians')!;
    expect(j.color).toBe('#9e9e9e');
    expect(j.ringFraction).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `graphLayout.ts`** with dagre (`rankdir: 'BT'` so prereqs sit below dependents; edge `prereq: dependent → prereq`), decay math:

```ts
import dagre from 'dagre';
import { DECAY, type MasteryLevel } from '../../shared/loreweaver.js';

const COLORS: Record<MasteryLevel, string> = {
  unseen: '#9e9e9e', exposed: '#e0b040', practicing: '#5b8def', mastered: '#4caf7d',
};
const WINDOW: Partial<Record<MasteryLevel, number>> = {
  mastered: DECAY.masteredDays, practicing: DECAY.practicingDays,
};

export function layoutGraph(nodes: any[], now: Date) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'BT', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.slug, { width: 120, height: 60 });
  const edges: { src: string; dst: string; type: 'prereq' | 'deepens' }[] = [];
  for (const n of nodes) {
    for (const p of n.prereqs) if (g.hasNode(p)) { g.setEdge(n.slug, p); edges.push({ src: n.slug, dst: p, type: 'prereq' }); }
    for (const d of n.deepens) if (g.hasNode(d)) edges.push({ src: n.slug, dst: d, type: 'deepens' });
  }
  dagre.layout(g);
  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.slug);
      const effective: MasteryLevel = n.mastery?.effective ?? 'unseen';
      const window = WINDOW[effective];
      let daysLeft: number | null = null, ringFraction: number | null = null;
      if (window && n.mastery?.last_reinforced) {
        const elapsed = Math.floor((now.getTime() - new Date(n.mastery.last_reinforced).getTime()) / 86_400_000);
        daysLeft = Math.max(0, window - elapsed);
        ringFraction = daysLeft / window;
      }
      return {
        slug: n.slug, title: n.title, x: pos.x, y: pos.y,
        color: COLORS[effective], effective, daysLeft, ringFraction,
        misconceptions: n.mastery?.misconceptions ?? [],
      };
    }),
    edges: edges.map((e) => ({ ...e })),
  };
}
```

`GraphPanel.tsx`: fetch `/api/graph` on tab mount (poll every 30s while visible); render SVG — edges as lines between node centers (prereq: solid `#888` with arrowhead marker; deepens: dashed, 50% opacity); nodes as `<g>`: circle `r=16` filled `color`, decay ring as a second circle with `stroke-dasharray = [ringFraction*100, 100]` and `pathLength=100`, `⚠` text glyph when `misconceptions.length > 0` with `<title>` hover, label + `· {daysLeft}d` beneath. Click → `panelBus.openPage(slug)`; a small "Teach me this" button appears on the selected node and calls the composer: `useThreadRuntime().append(\`Teach me ${slug} now\`)` (import from `@assistant-ui/react`; GraphPanel must therefore render inside the provider — it does, via SidePanel). ViewBox sized from dagre graph dimensions; `overflow: auto` container.

- [ ] **Step 4: Tests PASS; build; typecheck; commit** — `git commit -m "feat: layered mastery graph panel with decay rings and misconception badges"`

---

### Task 9: Scheduler + native notifications

**Files:**
- Create: `src/server/scheduler.ts`, `src/server/notify.ts`
- Modify: `src/server/index.ts` (start scheduler)
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `Loreweaver.call('get_student_state', ...)` (Task 2), `DECAY` (Task 1), config `schedule` (Task 1).
- Produces: `computeDigest(state: Record<string, PageMasteryDetail-ish>, ledger: Ledger, now: Date): { items: DigestItem[], newLedger: Ledger }` — pure. `DigestItem = { slug, kind: 'decays-soon'|'decayed'|'review-due', message }`. Rules: `decays-soon` when 0 < daysLeft <= 3 for effective mastered/practicing; `decayed` when stored level > effective level; each `(slug, kind, last_reinforced)` triple notifies once (ledger keyed on that triple). `startScheduler(lw, cfg): CronTask` — daily at `digestHour` (skip inside quietHours), reads state via MCP, sends ONE `notify-send` summarizing items, persists ledger to `vault/.harness/notify.json`. `sendNotification(title, body)` in `notify.ts` via `execFile('notify-send', [title, body])`, warn-once if binary missing.

- [ ] **Step 1: Failing test** — `tests/scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeDigest } from '../src/server/scheduler.js';

const state = {
  derivatives: { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-01' },   // 41 elapsed → 4 left: no
  'chain-rule': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-06-05' },  // 37 elapsed → 8 left: no
  'loss-functions': { level: 'mastered', effective: 'mastered', last_reinforced: '2026-05-30' }, // 43 → 2 left: soon
  'gradient-descent': { level: 'practicing', effective: 'exposed', last_reinforced: '2026-05-01' }, // decayed
};
const now = new Date('2026-07-12');

describe('computeDigest', () => {
  it('flags decays-soon and decayed, not healthy pages', () => {
    const { items } = computeDigest(state as any, {}, now);
    expect(items.map((i) => `${i.slug}:${i.kind}`).sort()).toEqual([
      'gradient-descent:decayed', 'loss-functions:decays-soon',
    ]);
  });
  it('ledger suppresses repeat notifications for the same event', () => {
    const first = computeDigest(state as any, {}, now);
    const second = computeDigest(state as any, first.newLedger, new Date('2026-07-13'));
    expect(second.items).toEqual([]);
  });
  it('re-notifies after re-reinforcement resets the window', () => {
    const first = computeDigest(state as any, {}, now);
    const bumped = { ...state, 'loss-functions': { ...state['loss-functions'], last_reinforced: '2026-07-12' } };
    // decays again much later
    const later = computeDigest(
      { ...bumped, 'loss-functions': { ...bumped['loss-functions'] } } as any,
      first.newLedger, new Date('2026-08-24')); // 43 days after 2026-07-12 → 2 left again
    expect(later.items.some((i) => i.slug === 'loss-functions')).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `notify.ts` (execFile wrapper, `existsSync('/usr/bin/notify-send')` guard with one-time console.warn). `scheduler.ts`:

```ts
import cron from 'node-cron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DECAY, LEVELS, type MasteryLevel } from '../shared/loreweaver.js';
import type { HarnessConfig } from './config.js';
import type { Loreweaver } from './mcp.js';
import { sendNotification } from './notify.js';

export type Ledger = Record<string, true>; // key: `${slug}|${kind}|${last_reinforced}`
export interface DigestItem { slug: string; kind: 'decays-soon' | 'decayed'; message: string }

const WINDOW: Partial<Record<MasteryLevel, number>> = {
  mastered: DECAY.masteredDays, practicing: DECAY.practicingDays,
};

export function computeDigest(state: Record<string, any>, ledger: Ledger, now: Date) {
  const items: DigestItem[] = [];
  const newLedger: Ledger = { ...ledger };
  for (const [slug, m] of Object.entries(state)) {
    const decayed = LEVELS.indexOf(m.effective) < LEVELS.indexOf(m.level);
    const window = WINDOW[m.effective as MasteryLevel];
    const push = (kind: DigestItem['kind'], message: string) => {
      const key = `${slug}|${kind}|${m.last_reinforced}`;
      if (!newLedger[key]) { newLedger[key] = true; items.push({ slug, kind, message }); }
    };
    if (decayed) push('decayed', `${slug} slipped to ${m.effective} — review to restore`);
    else if (window) {
      const daysLeft = window - Math.floor((now.getTime() - new Date(m.last_reinforced).getTime()) / 86_400_000);
      if (daysLeft > 0 && daysLeft <= 3) push('decays-soon', `${slug} decays in ${daysLeft}d`);
    }
  }
  return { items, newLedger };
}

const ledgerPath = (vault: string) => join(vault, '.harness', 'notify.json');
const loadLedger = (vault: string): Ledger =>
  existsSync(ledgerPath(vault)) ? JSON.parse(readFileSync(ledgerPath(vault), 'utf8')) : {};

export function startScheduler(lw: Loreweaver, cfg: HarnessConfig) {
  return cron.schedule(`0 ${cfg.schedule.digestHour} * * *`, async () => {
    const hour = new Date().getHours();
    const [qStart, qEnd] = cfg.schedule.quietHours;
    const quiet = qStart > qEnd ? hour >= qStart || hour < qEnd : hour >= qStart && hour < qEnd;
    if (quiet) return;
    const state = await lw.call('get_student_state', { student: cfg.student });
    const details: Record<string, any> = {};
    for (const slug of Object.keys(state)) {
      const d = await lw.call('get_student_state', { student: cfg.student, slug });
      if (d.detail) details[slug] = d.detail;
    }
    const { items, newLedger } = computeDigest(details, loadLedger(cfg.vault), new Date());
    if (items.length) {
      sendNotification('Loreweaver', items.map((i) => i.message).join('\n'));
      mkdirSync(join(cfg.vault, '.harness'), { recursive: true });
      writeFileSync(ledgerPath(cfg.vault), JSON.stringify(newLedger));
    }
  }, { noOverlap: true });
}
```

Wire `startScheduler(lw, cfg)` in `index.ts`.

- [ ] **Step 4: Tests PASS; typecheck; commit** — `git commit -m "feat: decay digest scheduler with once-per-event ledger and native notifications"`

---

### Task 10: Anki bridge — outbound cards

**Files:**
- Create: `src/server/anki/client.ts`, `src/server/anki/outbound.ts`
- Test: `tests/anki-outbound.test.ts`

**Interfaces:**
- Consumes: `modelFor('card_gen', cfg)` (Task 3), `Loreweaver.call` (Task 2).
- Produces: `AnkiClient` (`invoke(action, params)` → POST `http://127.0.0.1:8765` `{action, version: 6, params}`, throws on `error`; `isUp(): Promise<boolean>` via `version` action); `syncOutbound(lw, anki, cfg): Promise<{pushed: number, updated: number, skipped: number}>` — for each slug at effective `practicing`+ (from student state details): generate cards with `card_gen` role (zod schema `{cards: [{front, back}]}`, max 4/page, misconceptions become cloze-style front lines), `createDeck('Loreweaver::<domain>')`, `addNote` (model `Basic`, tag `loreweaver::<slug>`, `duplicateScope: 'deck'`); ledger `vault/.harness/anki-map.json`: `{ [noteId]: { slug, hash } }` where hash = sha256 of front+back — unchanged hash skips, changed page content (different generated cards for same slug beyond count) uses `updateNoteFields`.
- Constructor takes `baseUrl` (default `http://127.0.0.1:8765`) — tests point it at a local fixture.

- [ ] **Step 1: Failing test** — `tests/anki-outbound.test.ts` spins a fake AnkiConnect on an ephemeral port:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AnkiClient } from '../src/server/anki/client.js';

const received: any[] = [];
let server: ReturnType<typeof serve>; let url: string;

beforeAll(async () => {
  const app = new Hono();
  let nextId = 1000;
  app.post('/', async (c) => {
    const body = await c.req.json();
    received.push(body);
    const results: Record<string, unknown> = {
      version: 6, createDeck: 1, addNote: nextId++, findNotes: [], notesInfo: [],
      updateNoteFields: null,
    };
    return c.json({ result: results[body.action] ?? null, error: null });
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => { url = `http://127.0.0.1:${info.port}`; resolve(); });
  });
});
afterAll(() => server.close());

describe('AnkiClient', () => {
  it('speaks the version-6 envelope', async () => {
    const anki = new AnkiClient(url);
    expect(await anki.isUp()).toBe(true);
    const id = await anki.invoke('addNote', { note: { deckName: 'D', modelName: 'Basic',
      fields: { Front: 'q', Back: 'a' }, options: { allowDuplicate: false, duplicateScope: 'deck' },
      tags: ['loreweaver::chain-rule'] } });
    expect(id).toBe(1000);
    const call = received.find((r) => r.action === 'addNote');
    expect(call.version).toBe(6);
    expect(call.params.note.tags).toEqual(['loreweaver::chain-rule']);
  });
  it('throws readable errors', async () => {
    const app = new Hono();
    app.post('/', (c) => c.json({ result: null, error: 'collection is not available' }));
    const s = serve({ fetch: app.fetch, port: 0 }, async (info) => {
      const bad = new AnkiClient(`http://127.0.0.1:${info.port}`);
      await expect(bad.invoke('addNote', {})).rejects.toThrow(/collection/);
      s.close();
    });
  });
});
```

Plus a ledger test: call `syncOutbound` twice with a stubbed `cardGen` (inject via `opts.generateCards` — signature `(slug, page, misconceptions) => Promise<{front, back}[]>` so no LLM in tests) against the fixture; expect second run `{pushed: 0, skipped: N}`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `client.ts` (~25 lines: fetch wrapper). `outbound.ts` per the interface block; card generation prompt for real path: "Create at most 4 atomic flashcards for this page. Front = one precise question; Back = the answer in ≤2 sentences. If misconceptions are listed, make the FIRST card target the misconception directly." with `Output.object({ schema: z.object({ cards: z.array(z.object({ front: z.string(), back: z.string() })).max(4) }) })`. Domain for deck name comes from `read_page` result (`page.domain || 'general'`). Persist ledger after each push (crash-safe).

- [ ] **Step 4: Tests PASS; typecheck; commit** — `git commit -m "feat: anki outbound sync — card generation, tagged decks, dedup ledger"`

---

### Task 11: Anki bridge — inbound evidence + lapse surfacing

**Files:**
- Create: `src/server/anki/inbound.ts`
- Modify: `src/server/session.ts` (bootstrap `ankiLapses` from inbound module), `src/server/index.ts` (cron every `ankiSyncMinutes`, plus run once at boot), `src/server/restRoutes.ts` (status: `anki: 'up'|'down'|'backlog'`)
- Test: `tests/anki-inbound.test.ts`

**Interfaces:**
- Consumes: `AnkiClient` (Task 10), `Loreweaver.call('record_evidence', ...)` (Task 2), ledger file (Task 10).
- Produces: `syncInbound(lw, anki, cfg, now?): Promise<{recorded: number}>` — cursor (`lastReviewMs`) stored in `vault/.harness/anki-map.json` under `_cursor`; pulls `cardReviews({deck: 'Loreweaver::*' — iterate decks from ledger slugs' domains, startID: cursor})`; tuple index 3 = ease (1=Again, 2=Hard, 3=Good, 4=Easy); resolve cardID → noteId → slug via `notesInfo`/ledger; aggregate per slug per local day: **any ease=1 → `record_evidence {kind: 'struggled', note: 'anki lapse (N cards)'}`; else all ≥2 → `record_evidence {kind: 'exposed', note: 'anki: N cards recalled'}`** (the maintain-never-promote ceiling — `exposed` refreshes `last_reinforced` without raising level). Advance cursor only after all evidence recorded. `recentLapses(vault, days=7): {slug, count}[]` reading a lapse log the sync appends to (`vault/.harness/anki-lapses.jsonl`: `{date, slug}` lines) — consumed by session bootstrap.
- `pause_turn`-style edge: if Anki is down, `syncInbound` returns `{recorded: 0}` without throwing.

- [ ] **Step 1: Failing test** — fake AnkiConnect returning scripted `cardReviews` tuples + `notesInfo`; temp vault + real Loreweaver (reuse Task 2 pattern); assertions:
  - ease-4 reviews on a slug already `practicing` → student file's `last_reinforced` updates but `level` stays `practicing` (read back via `get_student_state {slug}`; this asserts the ceiling END-TO-END through the real server);
  - ease-1 review → evidence kind `struggled` recorded; `anki-lapses.jsonl` gains a line; `recentLapses` returns `{slug, count: 1}`;
  - second `syncInbound` with no new reviews records nothing (cursor advanced);
  - Anki fixture offline (closed port) → resolves `{recorded: 0}`.

Write the test file with the same fixture structure as Task 10's (Hono fake on port 0, scripted responses per action; `cardReviews` returns `[[1783900000000, 55, -1, 4, 10, 5, 2500, 4000, 1]]` and `notesInfo` maps card 55's note to a ledger entry for slug `derivatives`). Seed the student to `practicing` first via two real `record_evidence` calls (`explained-correctly`, `applied-correctly`).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `inbound.ts`** per the interface block (~90 lines). Wire cron in `index.ts`:

```ts
cron.schedule(`*/${cfg.schedule.ankiSyncMinutes} * * * *`, () => syncInbound(lw, anki, cfg).catch(console.error), { noOverlap: true });
syncInbound(lw, anki, cfg).catch(console.error); // once at boot
```
In `session.ts` bootstrap, replace `ankiLapses: []` with `ankiLapses: recentLapses(cfg.vault)`. Status endpoint: `anki: await anki.isUp() ? 'up' : (backlogDays(cfg) > cfg.schedule.ankiBacklogNudgeDays ? 'backlog' : 'down')`; backlog nudge notification goes through Task 9's `sendNotification`, keyed in the notify ledger as `anki|backlog|<week>`.

- [ ] **Step 4: Tests PASS; typecheck; commit** — `git commit -m "feat: anki inbound sync — maintain-never-promote evidence, lapse surfacing at bootstrap"`

---

### Task 12: systemd service, README, scripted-model E2E

**Files:**
- Create: `systemd/loreweaver-harness.service`, `README.md`, `tests/e2e/scripted-model.cjs`, `tests/e2e/tutor-loop.spec.ts`, `playwright.config.ts`, `harness.config.json` (developer's real config — **gitignored**; add `harness.config.json` to `.gitignore`)
- Modify: `package.json` (scripts: `e2e`, `start`)

**Interfaces:**
- Consumes: everything.
- Produces: `createScriptedModel(scriptPath)` (CommonJS so `require()` in `models.ts` works): reads a JSON script `{turns: [{toolCalls?: [{toolName, input}], text}]}` and returns a `LanguageModel` whose `doStream` pops the next turn, emitting tool-call chunks then text chunks (LanguageModelV3 stream part shapes — copy chunk `type` names from Task 5's mock usage). Playwright config starts the real server (`LW_MOCK_MODEL=tests/e2e/script.json HARNESS_CONFIG=tests/e2e/e2e.config.json tsx src/server/index.ts`) + `vite preview`.

- [ ] **Step 1: E2E script + failing spec.** `tests/e2e/script.json`: turn 1 = tool call `quick_check {question: 'What does a derivative measure?', mode: 'choice', choices: ['slope at a point', 'area under curve'], expected: 'slope at a point', pageSlug: 'derivatives'}` + text "Let's warm up."; turn 2 = tool call `record_evidence {student: 'e2e', slug: 'derivatives', kind: 'applied-correctly', note: 'quick check'}` + text "Recorded — nice.". `e2e.config.json` points at a fixture vault created by a Playwright `globalSetup` (one `derivatives.md` page, embeddings `fake`, student `e2e`).

`tests/e2e/tutor-loop.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('full loop: bootstrap → quick_check → answer → evidence recorded', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Ask your tutor…').fill('hi');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'slope at a point' }).click();
  await expect(page.getByText(/correct/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Recorded — nice/)).toBeVisible({ timeout: 15_000 });
  const studentFile = JSON.parse(readFileSync(process.env.E2E_VAULT + '/students/e2e.json', 'utf8'));
  expect(studentFile.derivatives.evidence.some((e: any) => e.kind === 'applied-correctly')).toBe(true);
});
```

- [ ] **Step 2: Run `npx playwright test` → FAIL.**

- [ ] **Step 3: Implement** `scripted-model.cjs`, `playwright.config.ts` (webServer array: harness server + `vite preview --port 4173`, `baseURL: 'http://localhost:4173'`, proxy: build with `vite build` first in `webServer.command`), `globalSetup` creating the temp vault and exporting `E2E_VAULT`.

`systemd/loreweaver-harness.service`:
```ini
[Unit]
Description=Loreweaver tutoring harness
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/Dev/personal/loreweaver-harness
ExecStart=/usr/bin/npx tsx src/server/index.ts
Environment=HARNESS_CONFIG=%h/Dev/personal/loreweaver-harness/harness.config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`README.md`: what it is (one paragraph + screenshot placeholder-free description), setup (Node 22, `npm i`, copy `harness.config.example.json` → `harness.config.json`, set `ANTHROPIC_API_KEY` via systemd override or shell env, install Anki + AnkiConnect add-on `2055492159`, optional `ollama pull nomic-embed-text`), run (`npm run dev:server` + `npm run dev:client` for dev; `systemctl --user enable --now loreweaver-harness` + `npm run build` + serve `dist/` via the Hono server's static middleware — add `app.use('/*', serveStatic({ root: './dist' }))` from `@hono/node-server/serve-static` as the fallback route in `index.ts`), and the evidence model in five lines (levels, decay, the Anki ceiling).

- [ ] **Step 4: Full suite green:**

```bash
npx vitest run && npx tsc --noEmit && npx playwright test
```

- [ ] **Step 5: Commit** — `git commit -m "feat: systemd service, README, scripted-model E2E for the full tutor loop"`

---

## Self-review notes (already applied)

- **Spec coverage:** §3 architecture → Tasks 2/5/6; §4 blocks → Tasks 1/4/7; §5 loop/guardrail/routing → Tasks 3/5; §6 graph → Task 8; §7 scheduler → Task 9; §8 Anki → Tasks 10/11; §9 config → Task 1; §10 harness state → Tasks 5/9/10/11; §11 errors → respawn (T2), guardrail log (T5), status badges (T2/T11), zod boot (T1); §12 testing → every task + T12 E2E. Spec's "compile role" is config-only in v1 (no UI flow) — matches spec §2/§9 which reserve but do not surface it.
- **Known narrowing (documented in Task 5):** the guardrail's mechanical trigger covers block outputs only; "concept presented" enforcement is prompt-level.
- **Flux points with sanctioned fallbacks (executor: check installed typings, do not improvise beyond these):** `MockLanguageModelV3` name (T5), `result.toUIMessageStream()` vs `toUIMessageStream({stream})` (T5), `Output.object`/`experimental_output` (T4).
- **Type consistency:** `Grade`/`grading` field shape (T4) is what QuickCheck/WritingDraft render (T7) and what `pendingBlockOutputs` marks as graded (T5); `PageMasteryDetail` (T1) is what `/api/graph` embeds (T2) and `layoutGraph` consumes (T8); ledger key shapes named per file (T9 `notify.json`, T10/11 `anki-map.json`).
