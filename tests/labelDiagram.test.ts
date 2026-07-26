// label_diagram grading — the block that lets picture-first subjects mint applied evidence.
// Mechanical both ways: right placements earn applied-correctly, wrong or missing ones do not.

import { describe, it, expect } from 'vitest';
import { gradeBlockOutput } from '../src/server/grading.js';
import type { HarnessConfig } from '../src/server/config.js';

const cfg = { models: { grader: { model: 'x' } } } as unknown as HarnessConfig;
const input = {
  prompt: 'Label the chambers.', pageSlug: 'heart',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  regions: [
    { id: 'top', x: 30, y: 20, label: 'Left atrium' },
    { id: 'bottom', x: 30, y: 70, label: 'Left ventricle' },
  ],
  distractors: ['Aorta'],
};
const grade = (placements: any[]) =>
  gradeBlockOutput('label_diagram' as any, input, { placements }, cfg, undefined as any);

describe('label_diagram grading', () => {
  it('all regions right -> applied-correctly, mechanically', async () => {
    const g = await grade([
      { regionId: 'top', label: 'left atrium' },        // case-insensitive on purpose
      { regionId: 'bottom', label: 'Left ventricle' },
    ]);
    expect(g.verdict).toBe('correct');
    expect(g.source).toBe('mechanical');
    expect(g.evidence[0].kind).toBe('applied-correctly');
  });

  it('a swapped pair is struggled, with the per-region verdicts saying which', async () => {
    const g = await grade([
      { regionId: 'top', label: 'Left ventricle' },
      { regionId: 'bottom', label: 'Left atrium' },
    ]);
    expect(g.verdict).toBe('incorrect');
    expect(g.evidence[0].kind).toBe('struggled');
    expect(g.perItem).toEqual([
      { id: 'top', correct: false },
      { id: 'bottom', correct: false },
    ]);
  });

  it('a distractor placed instead of the right label does not count', async () => {
    const g = await grade([
      { regionId: 'top', label: 'Aorta' },
      { regionId: 'bottom', label: 'Left ventricle' },
    ]);
    expect(g.verdict).toBe('partial');
    expect(g.evidence[0].kind).toBe('struggled');
  });

  it('a blank region can never be all-correct', async () => {
    const g = await grade([{ regionId: 'top', label: 'Left atrium' }]);
    expect(g.verdict).toBe('partial');
    expect(g.evidence[0].kind).toBe('struggled');
  });
});
