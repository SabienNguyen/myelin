import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The sibling loreweaver checkout the integration tests spawn as the real MCP server.
//
// This used to be `${HOME}/Dev/personal/loreweaver` in every test file, which forced anyone whose
// checkouts live elsewhere (CI, a fresh clone) to symlink that exact path into place before the
// suite would run. Resolving it from THIS file's location instead — the sibling of the harness repo
// — makes the whole suite run wherever it sits, the same layout resolveLoreweaver() already falls
// back to. The historical path stays as a last resort so an existing symlinked setup keeps working.
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tests/ -> repo root
const sibling = join(HARNESS_ROOT, '..', 'loreweaver');

export const LW_REPO = existsSync(sibling)
  ? sibling
  : `${process.env.HOME}/Dev/personal/loreweaver`;
