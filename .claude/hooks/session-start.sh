#!/bin/bash
# SessionStart hook for Claude Code on the web: make the integration suites runnable.
#
# The harness's tests and e2e configs resolve BOTH repos through ~/Dev/personal
# (tests/mcp.test.ts, tests/crossRepoContract.test.ts, tests/e2e/*.config.json) — the layout of
# the machine they were written on. This hook recreates that layout with symlinks and installs
# dependencies, so a fresh web session can run `npx vitest run` without archaeology.
set -euo pipefail

# Local sessions already have a working layout — this is web-container setup only.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install

mkdir -p "$HOME/Dev/personal"
ln -sfn "$CLAUDE_PROJECT_DIR" "$HOME/Dev/personal/myelin"

# The engram sibling is present when the session was started with both repos. Without it the
# integration tests that spawn the real MCP server will fail loudly — which is honest; only the
# layout should never be the reason.
for sibling in "$CLAUDE_PROJECT_DIR/../engram" "$HOME/Dev/personal/../../user/engram" "/home/user/engram"; do
  if [ -d "$sibling" ] && [ -f "$sibling/package.json" ]; then
    real="$(cd "$sibling" && pwd)"
    ln -sfn "$real" "$HOME/Dev/personal/engram"
    (cd "$real" && npm install)
    break
  fi
done
