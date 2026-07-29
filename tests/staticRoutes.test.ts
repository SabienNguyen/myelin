import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStaticRoutes } from '../src/server/staticRoutes.js';

describe('buildStaticRoutes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'myelin-static-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>root marker</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'export default 1;');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The packaged app hands this an ABSOLUTE dist path and it must serve from that path verbatim.
  // A "slice the leading slash and re-add one" trick was a no-op on POSIX but mangled a Windows
  // path (`C:\…\dist` -> `/C:\…\dist`), so the packaged Windows app opened to "404 Not Found" for
  // index.html and every asset. These assertions pin serving-from-an-absolute-root.
  it('serves index.html and assets from an absolute root', async () => {
    const { app, found } = buildStaticRoutes(dir);
    expect(found).toBe(true);
    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('root marker');
    expect((await app.request('/assets/app.js')).status).toBe(200);
  });

  it('falls back to index.html for a deep link that is not a file', async () => {
    const { app } = buildStaticRoutes(dir);
    const deep = await app.request('/t/abc/page/x');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('root marker');
  });

  it('lets a missing /api route stay a 404 instead of returning the SPA HTML', async () => {
    const { app } = buildStaticRoutes(dir);
    const r = await app.request('/api/nope');
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('<!doctype');
  });

  it('reports not-found when the dist directory is absent', () => {
    expect(buildStaticRoutes(join(dir, 'nope')).found).toBe(false);
  });
});
