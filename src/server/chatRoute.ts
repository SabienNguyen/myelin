import { Hono } from 'hono';
import type { UIMessage } from '../shared/uiMessages.js';
import { COMMANDS, MODE_COMMANDS, isCommand, isStance } from '../shared/commands.js';
import type { HarnessConfig } from './config.js';
import type { Engram } from './mcp.js';
import { createTutorSession } from './session.js';
import { deriveMode, lastUserText } from './deriveMode.js';
import { deleteThread, listThreads, loadThread, saveThread } from './sessionStore.js';
import { clearStance, setStance } from './stanceStore.js';
import { MODES, type Mode } from './prompt.js';
import { detachedResponse } from './detachedResponse.js';

export function buildChatRoute(lw: Engram, cfg: HarnessConfig) {
  const app = new Hono();
  const { respond } = createTutorSession(lw, cfg);
  const runs = new Map<string, AbortController>();

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as {
      messages: UIMessage[]; mode?: Mode; threadId?: string; writeUp?: boolean; command?: string;
      /** Kinds in the current session plan, leading item first — lets the harness derive the mode
       *  when the client sends none. */
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
    const commandMode = command !== undefined && (MODE_COMMANDS as readonly string[]).includes(command)
      ? (command as Mode) : undefined;
    // One-shot "write this up" from a teaching mode (OfferWrite.tsx's writeUp flag, and now the
    // /write command — same promotion): promote THIS turn to freeform so the single-writer vault
    // path unlocks — the client's visible mode never changed, and because the promotion rides one
    // request only, the next turn reverts to the real mode. Writing still happens under freeform's
    // rules, so the single-writer invariant holds.
    const writeUp = body.writeUp === true || command === 'write';
    const baseMode = commandMode ?? mode;
    const effectiveMode: Mode = writeUp && baseMode !== 'freeform' ? 'freeform' : baseMode;
    const threadId = body.threadId ?? 'default';
    // The thread id becomes a file name below (sessionStore's assertThreadId, stanceStore has no
    // such check of its own) — reject a bad one BEFORE setStance so a doomed turn never leaves a
    // stance file behind under an id that saveThread would then refuse.
    try {
      loadThread(cfg.vault, threadId);
    } catch (e: any) {
      return c.json({ error: e?.message ?? String(e) }, 400);
    }
    if (runs.has(threadId)) return c.json({ error: 'This thread already has a running turn.' }, 409);
    // A stance command persists BEFORE the turn runs, so session.ts's tail note already carries
    // the new stance on this very turn — a bare "/beginner" with no text still runs a turn, and
    // the tutor answers it already teaching at the new level.
    if (isStance(command)) setStance(cfg.vault, threadId, command);
    saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
    // A page reload only drops delivery; the server still completes and persists the turn.
    const controller = new AbortController();
    runs.set(threadId, controller);
    try {
      return detachedResponse(await respond(body.messages, effectiveMode, threadId, controller.signal),
        () => { runs.delete(threadId); });
    } catch (error) {
      runs.delete(threadId);
      throw error;
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
      runs.get(c.req.param('id'))?.abort();
      return c.json({ ok: true });
    } catch (error: any) {
      return c.json({ error: error?.message ?? String(error) }, 400);
    }
  });
  app.get('/api/threads', (c) => c.json(listThreads(cfg.vault)));
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
      return c.json({ error: e?.message ?? String(e) }, 400);
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
    return c.body(null, 204);
  });
  return app;
}
