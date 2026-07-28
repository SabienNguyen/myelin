import { Hono } from 'hono';
import type { UIMessage } from 'ai';
import { isClaudeSdkModel } from './claudeSdk.js';
import { createClaudeSdkTutorSession } from './claudeSdkTutor.js';
import type { HarnessConfig } from './config.js';
import type { Loreweaver } from './mcp.js';
import { createTutorSession } from './session.js';
import { deleteThread, listThreads, loadThread, saveThread } from './sessionStore.js';
import { MODES, type Mode } from './prompt.js';

// Both session implementations expose `respond`, but createTutorSession's ignores the extra
// threadId param (it doesn't need Agent SDK session-resume bookkeeping) — a function with fewer
// declared params is assignable to a wider call signature, so this union stays simple.
type Respond = (messages: UIMessage[], mode: Mode, threadId: string) => Promise<Response>;

export function buildChatRoute(lw: Loreweaver, cfg: HarnessConfig) {
  const app = new Hono();

  // Chosen PER REQUEST, not once at boot, and memoised per tutor model id. The route depends on
  // cfg.models.tutor.model, and that can change while the app is running: signing in with a Claude
  // subscription rewrites it (signin.ts's applyRoute). Deciding once meant the learner had to
  // restart the app to finish signing in, which is exactly the friction the setup flow removes.
  const sessions = new Map<string, Respond>();
  const respond: Respond = (messages, mode, threadId) => {
    const id = cfg.models.tutor.model;
    let existing = sessions.get(id);
    if (!existing) {
      existing = isClaudeSdkModel(id)
        ? createClaudeSdkTutorSession(lw, cfg).respond
        : createTutorSession(lw, cfg).respond;
      sessions.set(id, existing);
    }
    return existing(messages, mode, threadId);
  };

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as {
      messages: UIMessage[]; mode?: Mode; threadId?: string; writeUp?: boolean;
    };
    const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'learn';
    // One-shot "write this up" from a teaching mode (OfferWrite.tsx): promote THIS turn to
    // freeform so the single-writer vault path unlocks — the client's visible mode never changed,
    // and because writeUp rides one request only, the next turn reverts to the real mode. Writing
    // still happens under freeform's rules, so the single-writer invariant holds.
    const effectiveMode: Mode = body.writeUp && mode !== 'freeform' ? 'freeform' : mode;
    const threadId = body.threadId ?? 'default';
    saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
    return respond(body.messages, effectiveMode, threadId);
  });
  app.get('/api/threads', (c) => c.json(listThreads(cfg.vault)));
  app.get('/api/thread/:id', (c) => c.json(loadThread(cfg.vault, c.req.param('id'))));
  app.put('/api/thread/:id', async (c) => {
    saveThread(cfg.vault, c.req.param('id'), await c.req.json());
    return c.json({ ok: true });
  });
  app.delete('/api/thread/:id', (c) => {
    deleteThread(cfg.vault, c.req.param('id'));
    return c.body(null, 204);
  });
  return app;
}
