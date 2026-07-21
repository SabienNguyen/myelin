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
  const respond: Respond = isClaudeSdkModel(cfg.models.tutor.model)
    ? createClaudeSdkTutorSession(lw, cfg).respond
    : createTutorSession(lw, cfg).respond;

  app.post('/api/chat', async (c) => {
    const body = await c.req.json() as { messages: UIMessage[]; mode?: Mode; threadId?: string };
    const mode: Mode = MODES.includes(body.mode as Mode) ? (body.mode as Mode) : 'learn';
    const threadId = body.threadId ?? 'default';
    saveThread(cfg.vault, threadId, body.messages); // persist request-side; response side saved by client PUT
    return respond(body.messages, mode, threadId);
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
