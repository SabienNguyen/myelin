// The pure parts of scripts/eval-local-model.ts: trial accounting and report formatting. The
// script's model-driving half needs a live endpoint and is deliberately untested here — importing
// the module is safe because main() only fires when the file is the invoked script.
import { describe, it, expect } from 'vitest';
import { formatReport, parseArgs, summarize, type Trial } from '../scripts/eval-local-model.js';

const trial = (over: Partial<Trial>): Trial => ({
  kind: 'quick_check', page: 'bayes-theorem', outcome: 'first',
  calls: [{ ms: 1000 }], expectedViolation: false, ...over,
});

describe('summarize', () => {
  it('counts outcomes, violations, and every call across retries', () => {
    const trials = [
      trial({ outcome: 'first', calls: [{ ms: 800 }] }),
      trial({ outcome: 'retry', calls: [{ ms: 1200, error: 'bad' }, { ms: 1000 }], expectedViolation: true }),
      trial({ outcome: 'fallback', calls: [{ ms: 400, error: 'x' }, { ms: 600, error: 'y' }] }),
    ];
    expect(summarize(trials)).toEqual({
      n: 3, first: 1, retry: 1, fallback: 1, violations: 1,
      calls: 5, meanMs: 800, medianMs: 800,
    });
  });

  it('an even call count medians between the middle two; empty trials stay zeros', () => {
    const even = [trial({ calls: [{ ms: 100 }, { ms: 300 }] })];
    expect(summarize(even).medianMs).toBe(200);
    expect(summarize([])).toEqual({
      n: 0, first: 0, retry: 0, fallback: 0, violations: 0, calls: 0, meanMs: 0, medianMs: 0,
    });
  });
});

describe('formatReport', () => {
  it('renders one aligned row per trial plus the totals line', () => {
    const report = formatReport([
      trial({ outcome: 'first', calls: [{ ms: 812.4 }] }),
      trial({ page: 'tcp-handshake', outcome: 'retry', calls: [{ ms: 1200 }, { ms: 900 }], expectedViolation: true }),
    ]);
    const lines = report.split('\n');
    expect(lines[0]).toMatch(/#\s+kind\s+page\s+outcome\s+latency\s+expected∈choices/);
    expect(report).toMatch(/1\s+quick_check\s+bayes-theorem\s+first\s+812ms\s+ok/);
    expect(report).toMatch(/2\s+quick_check\s+tcp-handshake\s+retry\s+1200ms \+ 900ms\s+VIOLATED/);
    expect(report).toContain(
      '2 trials — first try 1/2, retry 1, fallback 0; expected∉choices on 1; 3 calls',
    );
  });
});

describe('parseArgs', () => {
  it('takes the model id plus --n and --feedback in any order', () => {
    expect(parseArgs(['ollama:qwen3:8b'])).toEqual({ modelId: 'ollama:qwen3:8b', n: 12, feedback: false });
    expect(parseArgs(['--n', '20', 'ollama:qwen3:8b', '--feedback']))
      .toEqual({ modelId: 'ollama:qwen3:8b', n: 20, feedback: true });
  });

  it('rejects a missing model id, a bad --n, and an unknown flag', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['ollama:x', '--n', 'zero'])).toBeNull();
    expect(parseArgs(['ollama:x', '--fast'])).toBeNull();
  });
});
