import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { Loreweaver } from './mcp.js';
import { buildRestRoutes } from './restRoutes.js';
import { buildChatRoute } from './chatRoute.js';
import { startScheduler } from './scheduler.js';

const cfg = loadConfig();
const lw = await Loreweaver.connect(cfg);
startScheduler(lw, cfg);
const app = new Hono();
app.route('/', buildRestRoutes(lw, cfg));
app.route('/', buildChatRoute(lw, cfg));
serve({ fetch: app.fetch, port: cfg.port });
console.log(`loreweaver-harness on :${cfg.port}`);
