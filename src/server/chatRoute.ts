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
