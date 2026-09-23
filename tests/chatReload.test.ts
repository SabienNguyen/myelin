import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiStream } from '../src/server/llm/wire.js';
import { saveThread } from '../src/server/sessionStore.js';
import type { UIMessage } from '../src/shared/uiMessages.js';
import { serve } from '@hono/node-server';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { once } from 'node:events';
import { resolve } from 'node:path';

const probe = vi.hoisted(() => ({
  release: () => {},
  complete: () => {},
  signal: undefined as AbortSignal | undefined,
}));
vi.mock('../src/server/session.js', () => ({
  createTutorSession: (_lw: unknown, cfg: { vault: string }) => ({
    respond: async (messages: UIMessage[], _mode: string, threadId: string, signal: AbortSignal) =>
      createUiStream({
        originalMessages: messages, signal,
        execute: async (writer, runSignal) => {
          probe.signal = runSignal;
          writer.write({ type: 'text-start', id: 'answer' });
          writer.write({ type: 'text-delta', id: 'answer', delta: 'First half. ' });
          await new Promise<void>(resolve => { probe.release = resolve; });
          runSignal.throwIfAborted();
          writer.write({ type: 'text-delta', id: 'answer', delta: 'Final half.' });
          writer.write({ type: 'text-end', id: 'answer' });
        },
        onEnd: ({ messages: final }) => {
          saveThread(cfg.vault, threadId, final);
          probe.complete();
        },
      }),
  }),
}));
const { buildChatRoute } = await import('../src/server/chatRoute.js');

describe('chat survives a page reload', () => {
  it('a real browser reload recovers completion without a second chat POST', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'myelin-browser-reload-'));
    const app = buildChatRoute({} as any, { vault, student: 'kid' } as any);
    const backend = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(backend, 'listening');
    const address = backend.address() as { port: number };
    const vite = await createServer({ configFile: false, root: resolve('.'),
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${address.port}` } } });
    await vite.listen();
    // Same escape hatch as playwright.config.ts: a sandbox image that ships a pinned Chromium other
    // than the build this @playwright/test wants names it here instead of failing to launch.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      let posts = 0;
      page.on('request', req => { if (req.url().endsWith('/api/chat') && req.method() === 'POST') posts++; });
      // Minimal real-browser host for the production ChatStore; only the model is scripted.
      await page.route('**/reload-probe', route => route.fulfill({ contentType: 'text/html', body: `
        <button id="send">Send</button><pre id="state"></pre>
        <script type="module">
          import { ChatStore } from '/src/client/chatCore/chatStore.ts';
          const initial = await (await fetch('/api/thread/browser-reload')).json();
          const store = new ChatStore({ threadId: 'browser-reload', initialMessages: initial,
            requestContext: () => ({ mode: 'learn', writeUp: false }) });
          const show = () => document.querySelector('#state').textContent = JSON.stringify(store.getState());
          store.subscribe(show); show();
          document.querySelector('#send').onclick = () => store.sendMessage('Explain it');
          await store.recover(new AbortController().signal);
          document.body.dataset.ready = 'true';
        </script>` }));
      const url = `${vite.resolvedUrls!.local[0]}reload-probe`;
      await page.goto(url);
      await page.waitForSelector('body[data-ready="true"]');
      await page.click('#send');
      await page.waitForFunction(() => document.querySelector('#state')!.textContent!.includes('First half.'));
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#state')!.textContent!.includes('"isRunning":true'));
      expect(probe.signal?.aborted).toBe(false);
      probe.release();
      await page.waitForFunction(() => document.querySelector('#state')!.textContent!.includes('First half. Final half.'));
      await page.waitForSelector('body[data-ready="true"]');
      expect(posts).toBe(1);
    } finally {
      probe.release();
      await browser.close();
      await vite.close();
      await new Promise<void>((done, reject) => backend.close(error => error ? reject(error) : done()));
    }
  }, 30_000);

  // Turns now outlive their connection, so the client's own abort no longer ends one. A send
  // during a running turn used to get a bare 409: the client reported "unreachable", hid Stop
  // because it believed nothing was running, and the thread refused everything until the orphaned
  // turn finished on its own.
  it('a second send supersedes the running turn instead of being refused', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'myelin-supersede-'));
    const app = buildChatRoute({} as any, { vault, student: 'kid' } as any);
    const post = (text: string) => app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'supersede', messages: [{ id: text, role: 'user', parts: [{ type: 'text', text }] }] }),
    });
    const first = await post('first question');
    const firstSignal = probe.signal!;
    const releaseFirst = probe.release;
    const second = post('second question'); // aborts the first and waits for it to end
    await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));
    releaseFirst(); // the stubbed turn only notices the abort once its wait is released
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    const done = new Promise<void>((resolve) => { probe.complete = resolve; });
    await vi.waitFor(() => expect(probe.signal).not.toBe(firstSignal));
    probe.release();
    await done;
    await Promise.all([first.text(), secondResponse.text()]);
    expect(await (await app.request('/api/thread/supersede/run')).json()).toMatchObject({ running: false });
  });

  it('explicit Stop aborts the producer, unlike a disconnect', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'myelin-stop-'));
    const app = buildChatRoute({} as any, { vault, student: 'kid' } as any);
    const completed = new Promise<void>(resolve => { probe.complete = resolve; });
    const response = await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'stop-test', messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Explain it' }] },
      ] }),
    });
    const stopped = await app.request('/api/thread/stop-test/stop', { method: 'POST' });
    probe.release();
    await completed;
    await response.text();
    expect(stopped.status).toBe(200);
    expect(probe.signal?.aborted).toBe(true);
    expect(await (await app.request('/api/thread/stop-test/run')).json()).toMatchObject({ running: false });
  });

  it('persists the complete answer after the browser disconnects mid-stream', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'myelin-reload-'));
    const app = buildChatRoute({} as any, { vault, student: 'kid' } as any);
    const controller = new AbortController();
    const completed = new Promise<void>(resolve => { probe.complete = resolve; });
    const response = await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ threadId: 'reload-test', messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Explain it' }] },
      ] }),
    });
    const reader = response.body!.getReader();
    let received = '';
    while (!received.includes('First half.')) {
      const { value } = await reader.read();
      received += new TextDecoder().decode(value);
    }
    expect(await (await app.request('/api/thread/reload-test/run')).json()).toMatchObject({ running: true });
    const duplicate = await app.request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'reload-test', messages: [] }),
    });
    expect(duplicate.status).toBe(409);
    expect((await app.request('/api/thread/reload-test', { method: 'DELETE' })).status).toBe(409);
    expect((await app.request('/api/thread/reload-test', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([]),
    })).status).toBe(409);
    // A page reload closes both the request and its response reader.
    controller.abort();
    await reader.cancel();
    probe.release();
    await completed;
    const restored = await (await app.request('/api/thread/reload-test')).json() as UIMessage[];
    expect(restored.filter(m => m.role === 'assistant')).toHaveLength(1);
    const text = restored.flatMap(m => m.parts).filter(p => p.type === 'text').map(p => p.text).join('');
    expect(text).toContain('First half. Final half.');
  });
});

describe('detachedResponse idle watchdog', () => {
  // Closing the tab used to be what ended a turn whose provider stream had stalled; detached,
  // nothing did, and the thread answered 409 until the server restarted.
  it('ends a stream that has gone silent, calls onIdle, and still fires onEnd exactly once', async () => {
    const { detachedResponse } = await import('../src/server/detachedResponse.js');
    const silent = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); /* then nothing, ever */ },
    });
    let ends = 0; let idles = 0;
    const out = detachedResponse(new Response(silent), () => { ends += 1; }, { ms: 40, onIdle: () => { idles += 1; } });
    expect(await out.text()).toBe('first chunk');
    expect(idles).toBe(1);
    expect(ends).toBe(1);
  });

  it('a stream that keeps talking is never cut, however long it runs', async () => {
    const { detachedResponse } = await import('../src/server/detachedResponse.js');
    let n = 0;
    const chatty = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => { setTimeout(r, 25); });
        n += 1;
        if (n > 6) controller.close(); else controller.enqueue(new TextEncoder().encode(`${n},`));
      },
    });
    let idles = 0;
    const out = detachedResponse(new Response(chatty), () => {}, { ms: 60, onIdle: () => { idles += 1; } });
    expect(await out.text()).toBe('1,2,3,4,5,6,');
    expect(idles).toBe(0);
  });
});
