// Every test file starts with a throwaway OS config dir, so a test that writes settings.json or
// credentials.json without redirecting them lands in a temp dir, not the developer's real one. One
// that drove PUT /api/student wrote `student: "grownup"` into ~/.config/myelin, and the installed
// app then opened as that learner.
//
// XDG_CONFIG_HOME (Linux) and APPDATA (Windows) rather than MYELIN_CONFIG_DIR: credentialsPath
// checks MYELIN_CONFIG_DIR first, so setting it here would override the per-test XDG_CONFIG_HOME
// redirects that settings and setup-route tests rely on. macOS resolves under HOME and is not
// covered; CI and this repo's development run on Linux.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'myelin-test-config-'));
process.env.XDG_CONFIG_HOME = dir;
process.env.APPDATA = dir;
