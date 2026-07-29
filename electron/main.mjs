// The desktop shell: one window, one local server, nothing to configure.
//
// The web app already works as a single process on a single port (src/server/staticRoutes.ts serves
// the built client alongside the API), so this file's whole job is the three things a browser tab
// cannot do — pick a port that is free, know when the server is ready, and find the bundled
// Engram inside a packaged app.
//
// The server runs IN this process rather than as a child. It is the same Node runtime, the failure
// modes are the ones the server already handles, and a child would need its own ELECTRON_RUN_AS_NODE
// dance for no gain. What it does mean: an unhandled throw at server boot must show as a window
// saying so, not as an app that silently never appears — see showBootFailure below.

import { app, BrowserWindow, shell } from 'electron';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** A port the OS just told us is free. Beats defaulting to 4820 and dying on EADDRINUSE when the
 *  user already has the dev server running, or a second copy of the app open. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Where the bundled Engram lives.
 *
 * Packaged, it is an unpacked extra resource (it has to be: Node cannot spawn a script from inside
 * an asar archive). Unpackaged, it is the `vendor/` copy that scripts/bundle-engram.mjs makes.
 * Returning null is fine — src/server/config.ts's resolveEngram then falls back to a sibling
 * checkout, which is exactly what a developer running `npm run desktop` wants.
 */
function bundledEngram() {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'engram', 'dist', 'server.js')]
    : [join(here, '..', 'vendor', 'engram', 'dist', 'server.js')];
  return candidates.find(existsSync) ?? null;
}

async function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  // Poll /api/status rather than the root: the root is served by the static handler, which answers
  // as soon as the port is bound, while /api/status only answers once the routes are mounted — and
  // mounting waits on the MCP connection, which is the slow part.
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    title: 'Engram',
    backgroundColor: '#f5f2ea', // matches --bg, so the first paint is not a white flash
    show: false,
    webPreferences: {
      // No preload, no node integration, no bridge. The renderer is the same web app a browser
      // would load and talks to the server over HTTP like any other client — so there is no reason
      // to give it privileges, and every reason not to.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // External links (the console.anthropic.com link in the setup gate, sources on a page) belong in
  // the user's real browser, not in a chromeless app window they cannot navigate back out of.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); }
  });
  win.loadURL(url);
  return win;
}

function showBootFailure(message) {
  const win = new BrowserWindow({ width: 720, height: 420, title: 'Engram', backgroundColor: '#f5f2ea' });
  const body = `<h1>Engram could not start</h1><pre>${
    String(message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  }</pre>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    `<meta name="color-scheme" content="light dark"><style>
       body{font:15px/1.6 system-ui;margin:2rem;color:#26241f;background:#f5f2ea}
       pre{white-space:pre-wrap;background:#ebe6da;padding:1rem;border-radius:6px}
       @media (prefers-color-scheme:dark){body{color:#e7e1d2;background:#1d1b16}pre{background:#2c2a22}}
     </style>${body}`,
  )}`);
}

app.whenReady().then(async () => {
  try {
    const port = await freePort();
    process.env.HARNESS_PORT = String(port);

    const entry = bundledEngram();
    if (entry) process.env.ENGRAM_ENTRY = entry;

    // Imported, not spawned — and imported AFTER the env above is set, because the server reads its
    // config at module load.
    const server = app.isPackaged
      ? join(process.resourcesPath, 'app.asar', 'dist-server', 'server', 'index.js')
      : join(here, '..', 'dist-server', 'server', 'index.js');
    if (!existsSync(server)) throw new Error(`No server build at ${server}. Run \`npm run build:all\`.`);
    await import(`file://${server}`);

    const url = `http://127.0.0.1:${port}`;
    if (!await waitForServer(port)) {
      throw new Error('The server started but never became ready. Check the log for a Engram '
        + 'connection failure.');
    }
    createWindow(url);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  } catch (e) {
    console.error(e);
    showBootFailure(e?.stack ?? e?.message ?? e);
  }
});

// Standard on Windows/Linux; on macOS the app conventionally stays alive with no windows.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
