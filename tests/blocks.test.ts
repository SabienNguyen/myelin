import { describe, it, expect, beforeAll } from 'vitest';
import { BLOCK_TOOLS, BLOCK_TOOL_NAMES } from '../src/shared/blocks.js';

describe('block schemas', () => {
  // Was "the five v1 kinds". structured_check is the sixth: the generic applied block, added so
  // applied evidence is reachable outside maths/prose/programming (see src/shared/blocks.ts). This
  // list stays exhaustive on purpose — a new block kind should have to be added here deliberately.
  it('exposes exactly the nine block kinds', () => {
    expect(BLOCK_TOOL_NAMES.sort()).toEqual(
      ['code_exercise', 'label_diagram', 'math_scratchpad', 'pronounce', 'quick_check', 'quiz', 'structured_check', 'watch_video', 'writing_draft'],
    );
  });
  it('structured_check round-trips each checker kind', () => {
    const base = { prompt: 'p', pageSlug: 'topic' };
    const kinds = [
      { kind: 'unit', expected: 20, unit: 'm/s' },
      { kind: 'chem_equation', reactants: ['CH4', 'O2'], products: ['CO2', 'H2O'] },
      { kind: 'notes', expected: ['C', 'E', 'G'] },
      { kind: 'numeric', expected: 9.81, tolerance: 0.01, unit: 'm/s^2' },
      { kind: 'set', expected: ['a', 'b'] },
      { kind: 'sequence', expected: ['a', 'b'] },
      { kind: 'matching', items: [{ left: 'l', right: 'r' }] },
      { kind: 'vector', expected: [3, 4], tolerance: 0.01 },
      { kind: 'pattern', expected: 'sodium chloride' },
    ];
    for (const checker of kinds) {
      expect(BLOCK_TOOLS.structured_check.input.parse({ ...base, checker })).toMatchObject({ checker });
    }
    expect(BLOCK_TOOLS.structured_check.result.parse({ values: ['9.81 m/s^2'] }))
      .toEqual({ values: ['9.81 m/s^2'] });
  });
  it('quick_check round-trips', () => {
    const input = { question: '2+2?', mode: 'choice', choices: ['3', '4'], pageSlug: 'arith' };
    expect(BLOCK_TOOLS.quick_check.input.parse(input)).toEqual(input);
    expect(BLOCK_TOOLS.quick_check.result.parse({ answer: '4' })).toEqual({ answer: '4' });
  });
  it('math_scratchpad requires problemLatex', () => {
    expect(() => BLOCK_TOOLS.math_scratchpad.input.parse({ stepMode: true })).toThrow();
  });
  it('code_exercise round-trips', () => {
    const input = { pattern: 'stream-consumer', rung: 'ladder', pageSlug: 'stream-consumer' };
    expect(BLOCK_TOOLS.code_exercise.input.parse(input)).toEqual(input);
    const result = { completed: true, rungReached: 'full_body', testsPassed: 8, testsTotal: 8, wroteCode: true };
    expect(BLOCK_TOOLS.code_exercise.result.parse(result)).toEqual(result);
  });
  it('watch_video round-trips, with and without the snippet bounds', () => {
    const full = {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', startSeconds: 225, endSeconds: 300,
      title: 'Quadratic formula', why: 'watch how completing the square becomes the formula',
      pageSlug: 'quadratic-formula',
    };
    expect(BLOCK_TOOLS.watch_video.input.parse(full)).toEqual(full);
    const bare = { url: 'https://youtu.be/dQw4w9WgXcQ', why: 'the whole short', pageSlug: 'p' };
    expect(BLOCK_TOOLS.watch_video.input.parse(bare)).toEqual(bare);
    expect(BLOCK_TOOLS.watch_video.result.parse({ watched: true })).toEqual({ watched: true });
    // Negative seconds are a malformed assignment, not a snippet.
    expect(() => BLOCK_TOOLS.watch_video.input.parse({ ...bare, startSeconds: -5 })).toThrow();
  });
  it('code_exercise rejects an unknown rung value', () => {
    expect(() => BLOCK_TOOLS.code_exercise.input.parse(
      { pattern: 'stream-consumer', rung: 'bogus', pageSlug: 'stream-consumer' },
    )).toThrow();
  });
});

describe('structural rule 1a on the ai-sdk route', () => {
  it('grading turns get only the navigation UI tools; user turns get every block', async () => {
    const { turnBlockTools } = await import('../src/server/session.js');
    // open_source, speak, offer_write are navigation, not graded work — all survive the withhold.
    expect(Object.keys(turnBlockTools(true)).sort()).toEqual(['offer_write', 'open_source', 'speak']);
    const full = Object.keys(turnBlockTools(false));
    expect(full).toContain('quiz');
    expect(full).toContain('writing_draft');
    expect(full).toContain('open_source');
    expect(full).toContain('speak');
    expect(full).toContain('offer_write');
  });
});


describe('slugListLine — slug grounding capped for scale', () => {
  // Dynamic import, matching this file's turnBlockTools pattern: a top-level import of
  // session.js would drag its module graph through every OTHER test in this file.
  let slugListLine: (slugs: string[], relevant?: string[]) => string;
  beforeAll(async () => { ({ slugListLine } = await import('../src/server/session.js')); });

  it('small vaults inline every slug, verbatim, as always', () => {
    const line = slugListLine(['a', 'b', 'c']);
    expect(line).toContain('ONLY valid slugs');
    expect(line).toContain('a, b, c');
  });

  it('past the cap, only this sitting\'s pages inline — plus an honest count and the way to the rest', () => {
    const slugs = Array.from({ length: 500 }, (_, i) => `page-${i}`);
    const line = slugListLine(slugs, ['page-3', 'page-77', 'not-a-real-slug', 'page-3']);
    expect(line).toContain('page-3, page-77');           // deduped, filtered to real slugs
    expect(line).not.toContain('page-200');              // the bulk stays out of the prompt
    expect(line).toContain('plus 498 more');             // count stays honest
    expect(line).toMatch(/search tool/);
    expect(line).toMatch(/auto-corrected/);              // repairSlug still guards misses
    expect(line.length).toBeLessThan(400);               // the point: no multi-thousand-token line
  });

  it('past the cap with nothing relevant yet, says so instead of inlining nothing silently', () => {
    const slugs = Array.from({ length: 200 }, (_, i) => `p${i}`);
    expect(slugListLine(slugs, [])).toContain('(none yet)');
  });
});
