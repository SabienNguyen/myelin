import { describe, it, expect } from 'vitest';
import { buildIngestRoutes } from '../src/server/ingestRoutes.js';

// A multipart upload's file.name is client-controlled and becomes a path under a temp dir. A
// traversal name must not reach writeFileSync unsanitized. The two names that survive basename() —
// "." and ".." — are rejected outright (they'd still escape the temp dir); everything else is
// reduced to its basename before the write. These guard cases return 400 before startConversion,
// so no Loreweaver or converter is needed to exercise them.
const cfg = { vault: '/tmp/lwh-ingest-upload-test' } as any;

async function uploadNamed(filename: string): Promise<Response> {
  const app = buildIngestRoutes(null as any, cfg, {});
  const fd = new FormData();
  fd.append('file', new File(['hello'], filename));
  return app.request('/api/ingest', { method: 'POST', body: fd });
}

describe('ingest upload — filename containment', () => {
  it('rejects the traversal basenames that survive basename() ("." and "..")', async () => {
    for (const name of ['..', '.']) {
      const res = await uploadNamed(name);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/invalid file name/);
    }
  });

  it('rejects an empty filename', async () => {
    const res = await uploadNamed('');
    expect(res.status).toBe(400);
  });

  it('rejects a bare "/" (basename is empty)', async () => {
    const res = await uploadNamed('/');
    expect(res.status).toBe(400);
  });
});
