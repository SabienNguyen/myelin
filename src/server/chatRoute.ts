import { Hono } from 'hono';
import type { UIMessage } from '../shared/uiMessages.js';
import { COMMANDS, MODE_COMMANDS, isCommand, isStance } from '../shared/commands.js';
import type { HarnessConfig } from './config.js';
import type { Engram } from './mcp.js';
import { createTutorSession } from './session.js';
import { deleteThread, listThreads, loadThread, saveThread } from './sessionStore.js';
import { clearStance, setStance } from './stanceStore.js';
import { MODES, type Mode } from './prompt.js';

export function buildChatRoute(lw: Engram, cfg: HarnessConfig) {
  const app = new Hono();
  const { respond } = createTutorSession(lw, cfg);

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as {
      messages: UIMessage[]; mode?: Mode; threadId?: string; writeUp?: boolean; command?: string;
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
    const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'learn';
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
    // A stance command persists BEFORE the turn runs, so session.ts's tail note already carries
    // the new stance on this very turn — a bare "/beginner" with no text still runs a turn, and
    // the tutor answers it already teaching at the new level.
    if (isStance(command)) setStance(cfg.vault, threadId, command);
    saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
    // The request's own signal: the runtime fires it when the client disconnects (tab closed,
    // send superseded), and respond threads it down to the in-flight provider request.
    return respond(body.messages, effectiveMode, threadId, c.req.raw.signal);
  });
  app.get('/api/threads', (c) => c.json(listThreads(cfg.vault)));
  app.get('/api/thread/:id', (c) => c.json(loadThread(cfg.vault, c.req.param('id'))));
  app.put('/api/thread/:id', async (c) => {
    saveThread(cfg.vault, c.req.param('id'), await c.req.json());
    return c.json({ ok: true });
  });
  app.delete('/api/thread/:id', (c) => {
    deleteThread(cfg.vault, c.req.param('id'));
    clearStance(cfg.vault, c.req.param('id'));
    return c.body(null, 204);
  });
  return app;
}
