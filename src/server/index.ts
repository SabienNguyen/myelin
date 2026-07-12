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
