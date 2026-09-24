import { Hono } from 'hono';
import type { UIMessage } from '../shared/uiMessages.js';
import { COMMANDS, commandMode, isCommand, isStance } from '../shared/commands.js';
import type { HarnessConfig } from './config.js';
import type { Engram } from './mcp.js';
import { createTutorSession } from './session.js';
import { deriveMode, lastUserText } from './deriveMode.js';
import { ThreadDeleted, assertNotDeleted, deleteThread, listThreads, loadThread, saveThread } from './sessionStore.js';
import { clearStance, setStance } from './stanceStore.js';
import { forgetThread, readNotebooks } from './notebookStore.js';
import { MODES, type Mode } from './prompt.js';
import { detachedResponse } from './detachedResponse.js';
import { TurnStalled } from './turnError.js';

export function buildChatRoute(lw: Engram, cfg: HarnessConfig) {
  const app = new Hono();
  const { respond } = createTutorSession(lw, cfg);
  // `done` settles when the turn has fully ended (its thread saved, its entry removed), so a
  // superseding send can wait for that rather than race the old turn's final save.
  const runs = new Map<string, { controller: AbortController; done: Promise<void>; lastUserId?: string }>();
  // Generous on purpose: a turn is silent while a tool runs, and the slowest tool (building the
  // kind cluster, then an exercise's rollout gate) takes minutes. This is for a stream that will
  // never speak again, not one that is slow.
  const IDLE_MS = 10 * 60_000;
  const SUPERSEDE_WAIT_MS = 10_000;

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as {
      messages: UIMessage[]; mode?: Mode; threadId?: string; writeUp?: boolean; command?: string;
      /** Kinds in the current session plan, leading item first. The web client does not send
       *  it: starting a plan sets a sticky mode instead, and a plan-led derivation would turn
       *  every "ok" in chat into a review (chat-first design). deriveMode still takes it: its
       *  tests use a plan-led baseline to catch an ask pattern that misfires. */
      planKinds?: string[];
      /** True when the vault holds nothing real to teach from. */
      emptyVault?: boolean;
    };
    // Slash commands arrive structured, validated against the one shared list — an unknown name
    // is a client bug (the menu only offers known commands), so fail loud and name the valid set
    // rather than silently running the turn without whatever the command was meant to do.
    if (body.command !== undefined && !isCommand(body.command)) {
      return c.json({
        error: `unknown command "${body.command}" — valid commands: ${COMMANDS.join(', ')}`,
      }, 400);
    }
    const command = body.command;
    // The client no longer has to send a mode. When it does not, the harness derives one from what
    // the learner actually said plus the session plan — the selector was asking a human to answer a
    // question the system is better placed to answer, and three separate mechanisms had already
    // grown up to route around it (coldStartMode, writeIntent's one-shot promotion, and the mode
    // slash commands). An explicit body.mode still wins, so nothing that sends one changes
    // behaviour; see deriveMode.ts.
    const mode: Mode = MODES.includes(body.mode as Mode)
      ? (body.mode as Mode)
      : deriveMode({
        text: lastUserText(body.messages ?? []),
        planKinds: Array.isArray(body.planKinds) ? body.planKinds : [],
        emptyVault: body.emptyVault === true,
      });
    // A mode command overrides the selector for THIS turn only server-side; the client flips its
    // own selector on send, so the following turns carry the new mode in body.mode as usual.
    // `/study` is the tutor, so it maps onto `learn` (commandMode in shared/commands.ts).
    const baseMode: Mode = (command !== undefined ? commandMode(command) : undefined) ?? mode;
    // One-shot "write this up" from a teaching mode (OfferWrite.tsx's writeUp flag, and now the
    // /write command — same promotion): promote THIS turn to freeform so the single-writer vault
    // path unlocks — the client's visible mode never changed, and because the promotion rides one
    // request only, the next turn reverts to the real mode. Writing still happens under freeform's
    // rules, so the single-writer invariant holds. Chat can already write: promoting it would only
    // swap its prompt for the tutor's for one turn.
    const writeUp = body.writeUp === true || command === 'write';
    const teaching = baseMode === 'learn' || baseMode === 'review' || baseMode === 'quiz';
    const effectiveMode: Mode = writeUp && teaching ? 'freeform' : baseMode;
    const threadId = body.threadId ?? 'default';
    // The thread id becomes a file name below (sessionStore's assertThreadId, stanceStore has no
    // such check of its own) — reject a bad one BEFORE setStance so a doomed turn never leaves a
    // stance file behind under an id that saveThread would then refuse.
    try {
      loadThread(cfg.vault, threadId);
      assertNotDeleted(cfg.vault, threadId, body.messages ?? []);
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, e instanceof ThreadDeleted ? 409 : 400);
    }
    // A send while a turn is running SUPERSEDES it, as it did before turns outlived their
    // connection: then, the client's abort closed the socket and that ended the old turn. Now the
    // old turn survives a disconnect by design, so the server ends it. Refusing instead (a bare
    // 409) stranded the learner: the client showed "unreachable", hid Stop because it no longer
    // thought anything was running, and the thread refused every send until the orphan finished.
    //
    // A DUPLICATE is still refused: the same last user message (a double-fired request, a retry
    // racing a reload) must not kill the healthy turn that is already answering it.
    const lastUserId = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.id;
    const running = runs.get(threadId);
    if (running && (lastUserId === undefined || lastUserId === running.lastUserId)) {
      return c.json({ error: 'This thread already has a running turn.' }, 409);
    }
    if (running) {
      running.controller.abort();
      const ended = await Promise.race([
        running.done.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), SUPERSEDE_WAIT_MS); }),
      ]);
      if (!ended) {
        return c.json({ error: 'The previous turn is still shutting down — try again in a moment.' }, 409);
      }
    }
    // The two pre-stream writes below sat outside this try: an unwritable or full vault made them
    // throw past the handler, reaching the client as exactly the unparseable 500 it exists to kill.
    let end: (() => void) | undefined;
    try {
      // A stance command persists BEFORE the turn runs, so session.ts's tail note already carries
      // the new stance on this very turn — a bare "/beginner" with no text still runs a turn, and
      // the tutor answers it already teaching at the new level.
      if (isStance(command)) setStance(cfg.vault, threadId, command);
      saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
      // A page reload only drops delivery; the server still completes and persists the turn.
      const controller = new AbortController();
      let finish!: () => void;
      const entry = { controller, lastUserId, done: new Promise<void>((resolve) => { finish = resolve; }) };
      runs.set(threadId, entry);
      // Only this turn's own entry: a superseding turn may already have registered under the id.
      end = () => { if (runs.get(threadId) === entry) runs.delete(threadId); finish(); };
      return detachedResponse(await respond(body.messages, effectiveMode, threadId, controller.signal),
        end, { ms: IDLE_MS, onIdle: () => controller.abort(new TurnStalled(IDLE_MS)) });
    } catch (error) {
      end?.(); // a write may have thrown before the run was registered — nothing to unregister then
      // A throw BEFORE the stream exists is the one failure the closing guarantee in
      // createUiStream cannot cover — there is no response to write a note into. Hono would turn
      // it into a bare 500 whose body the client cannot parse, which shows up as the dead
      // "unreachable" state. Answer in the shape the client already reads instead.
      console.error('[chat-route]', error);
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `The turn could not be started: ${message}` }, 500);
    }
  });
  app.get('/api/thread/:id/run', (c) => {
    try {
      const messages = loadThread(cfg.vault, c.req.param('id'));
      return c.json({ running: runs.has(c.req.param('id')), messages });
    } catch (error: any) {
      return c.json({ error: error?.message ?? String(error) }, 400);
    }
  });
  app.post('/api/thread/:id/stop', (c) => {
    try {
      loadThread(cfg.vault, c.req.param('id'));
      runs.get(c.req.param('id'))?.controller.abort();
      return c.json({ ok: true });
    } catch (error: any) {
      return c.json({ error: error?.message ?? String(error) }, 400);
    }
  });
  // Each row names the notebook it is filed under, so history reads like a project list rather than
  // one undifferentiated stream of conversations.
  app.get('/api/threads', (c) => {
    const owner = new Map<string, { id: string; title: string }>();
    for (const nb of readNotebooks(cfg.vault)) for (const t of nb.threads) owner.set(t, { id: nb.id, title: nb.title });
    return c.json(listThreads(cfg.vault).map((t) => ({ ...t, notebook: owner.get(t.id) ?? null })));
  });
  // loadThread/saveThread/deleteThread throw on a threadId that fails sessionStore's filename
  // allowlist (assertThreadId) — a real client bug (nothing legitimate sends one), but it must
  // read as a 400 naming the problem, not a bare 500 with no message.
  app.get('/api/thread/:id', (c) => {
    try {
      return c.json(loadThread(cfg.vault, c.req.param('id')));
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 400);
    }
  });
  app.put('/api/thread/:id', async (c) => {
    if (runs.has(c.req.param('id'))) return c.json({ error: 'A turn is still running.' }, 409);
    try {
      saveThread(cfg.vault, c.req.param('id'), await c.req.json());
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, e instanceof ThreadDeleted ? 409 : 400);
    }
    return c.json({ ok: true });
  });
  app.delete('/api/thread/:id', (c) => {
    if (runs.has(c.req.param('id'))) return c.json({ error: 'Stop the running turn before deleting this thread.' }, 409);
    try {
      deleteThread(cfg.vault, c.req.param('id'));
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 400);
    }
    clearStance(cfg.vault, c.req.param('id'));
    forgetThread(cfg.vault, c.req.param('id'));
    return c.body(null, 204);
  });
  return app;
}
