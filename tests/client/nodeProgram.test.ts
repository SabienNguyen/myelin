import { describe, it, expect } from 'vitest';

// jsdom has no WebGL support at all, so it never defines these two browser globals — but sigma's
// rendering bundle reads their numeric GL enum constants at MODULE LOAD time (building an
// attribute-size lookup table, plus each program's draw METHOD), not lazily when a context is
// created. Without this, `import 'sigma/rendering'` throws
// `ReferenceError: WebGL2RenderingContext is not defined` before a single test runs — confirmed by
// running the import alone. The values below are fixed by the WebGL/WebGL2 spec, not sigma's own
// API, so supplying them lets the real sigma module load and run unmodified; this is not a stand-in
// for sigma the way `vi.mock('sigma/rendering', ...)` would be.
if (typeof (globalThis as { WebGLRenderingContext?: unknown }).WebGLRenderingContext === 'undefined') {
  (globalThis as Record<string, unknown>).WebGLRenderingContext = {
    UNSIGNED_BYTE: 5121, FLOAT: 5126, POINTS: 0, LINES: 1, TRIANGLES: 4,
  };
}
if (typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'undefined') {
  (globalThis as Record<string, unknown>).WebGL2RenderingContext = {
    BOOL: 35670, BYTE: 5120, UNSIGNED_BYTE: 5121, SHORT: 5122, UNSIGNED_SHORT: 5123,
    INT: 5124, UNSIGNED_INT: 5125, FLOAT: 5126,
  };
}

const { NodeProgram } = await import('sigma/rendering');
const { floatColor } = await import('sigma/utils');
const { MasteryNodeProgram, themedNodeHover } = await import('../../src/client/graph/nodeProgram.js');

// Records every 2D-context call themedNodeHover makes, without a real canvas — jsdom's own
// CanvasRenderingContext2D throws "not implemented" for most drawing methods.
function stubContext() {
  const calls: Array<[string, ...unknown[]]> = [];
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: 'left' as CanvasTextAlign,
    measureText: (text: string) => ({ width: text.length * 7 }) as TextMetrics,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (x: number, y: number) => calls.push(['translate', x, y]),
    scale: (x: number, y: number) => calls.push(['scale', x, y]),
    beginPath: () => calls.push(['beginPath']),
    closePath: () => calls.push(['closePath']),
    moveTo: (x: number, y: number) => calls.push(['moveTo', x, y]),
    lineTo: (x: number, y: number) => calls.push(['lineTo', x, y]),
    arc: (...args: number[]) => calls.push(['arc', ...args]),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
    fillText: (text: string, x: number, y: number) => calls.push(['fillText', text, x, y]),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const HOVER_SETTINGS = {
  labelSize: 12, labelWeight: '400', labelFont: 'mono', labelColor: { color: '#eeeeee' },
} as never;

describe('MasteryNodeProgram', () => {
  it("is exported and extends sigma's NodeProgram", () => {
    expect(MasteryNodeProgram).toBeTruthy();
    expect(MasteryNodeProgram.prototype).toBeInstanceOf(NodeProgram);
  });

  it('carries a warnColor uniform hook for T4 to set from resolveGraphColors().warn', () => {
    expect(typeof MasteryNodeProgram.warnColor).toBe('string');
  });

  // getDefinition() is pure data (no gl calls), so it can be read straight off the prototype: the
  // class can never be *constructed* in jsdom (the base Program class asks its constructor to
  // create real WebGL buffers/shaders, which needs an actual context jsdom cannot provide), but
  // that's fine — this test only needs to catch a broken import or a definition that silently
  // drops the two custom attributes.
  it('declares a_ringFraction and a_slipped as attributes on its shader definition', () => {
    const def = MasteryNodeProgram.prototype.getDefinition();
    const names = def.ATTRIBUTES.map((a: { name: string }) => a.name);
    expect(names).toContain('a_ringFraction');
    expect(names).toContain('a_slipped');

    const ringFraction = def.ATTRIBUTES.find((a: { name: string }) => a.name === 'a_ringFraction');
    const slipped = def.ATTRIBUTES.find((a: { name: string }) => a.name === 'a_slipped');
    expect(ringFraction?.size).toBe(1);
    expect(slipped?.size).toBe(1);
  });

  // What reaches the GPU per node. Swapping two writes, or passing a NaN position through, used to
  // pass every test while the canvas drew nothing where it should.
  it('writes position, size, colour, id, ring and slip for one node, in attribute order', () => {
    const program = Object.create(MasteryNodeProgram.prototype) as InstanceType<typeof MasteryNodeProgram>;
    const array = new Float32Array(9);
    (program as unknown as { array: Float32Array }).array = array;
    const node = { x: 0.25, y: 0.75, size: 12, color: '#5b8def', ringFraction: 0.4, slipped: true };
    program.processVisibleItem(3, 1, node as never);
    expect(array[0]).toBe(0);
    expect(Array.from(array.slice(1, 4))).toEqual([0.25, 0.75, 12]);
    expect(array[4]).toBe(floatColor('#5b8def'));
    expect(array[5]).toBe(3);
    expect(array[6]).toBeCloseTo(0.4);
    expect(array[7]).toBe(1);
    expect(array[8]).toBe(0);

    const names = MasteryNodeProgram.prototype.getDefinition().ATTRIBUTES.map((a: { name: string }) => a.name);
    expect(names).toEqual(['a_position', 'a_size', 'a_color', 'a_id', 'a_ringFraction', 'a_slipped']);
  });

  it('writes -1 for no decay ring and 0 for a page that has not slipped', () => {
    const program = Object.create(MasteryNodeProgram.prototype) as InstanceType<typeof MasteryNodeProgram>;
    const array = new Float32Array(7);
    (program as unknown as { array: Float32Array }).array = array;
    program.processVisibleItem(0, 0, { x: 1, y: 2, size: 3, color: '#000000', ringFraction: null, slipped: false } as never);
    expect(array[5]).toBe(-1);
    expect(array[6]).toBe(0);
  });
});

describe('themedNodeHover', () => {
  it('draws the box and its own full-text copy on the right when the node has room there', () => {
    const { ctx, calls } = stubContext();
    const drawHover = themedNodeHover(() => ({ fill: '#111111', stroke: '#333333' }), () => 600);
    const data = { x: 100, y: 50, size: 10, label: 'Attention Head' } as never;
    drawHover(ctx, data, HOVER_SETTINGS);

    expect(calls.find((c) => c[0] === 'scale')).toEqual(['scale', 1, 1]);
    const fillTextCall = calls.find((c) => c[0] === 'fillText');
    expect(fillTextCall).toEqual(['fillText', 'Attention Head', 100 + 10 + 3, 50 + 12 / 3]);
    // The stock drawDiscNodeLabel copy (always right-anchored) must not also run — that was the
    // double-label bug for a node whose fitted label sits on the left.
    expect(calls.filter((c) => c[0] === 'fillText')).toHaveLength(1);
  });

  it('flips the box and its text to the left, and draws the full title, when a node sits at the right edge', () => {
    const { ctx, calls } = stubContext();
    const drawHover = themedNodeHover(() => ({ fill: '#111111', stroke: '#333333' }), () => 200);
    // 30px of room on the right of a 200px canvas — not enough for this label's box; the left is
    // wide open.
    const data = { x: 190, y: 50, size: 10, label: 'A Much Longer Node Title' } as never;
    drawHover(ctx, data, HOVER_SETTINGS);

    expect(calls.find((c) => c[0] === 'scale')).toEqual(['scale', -1, 1]);
    const fillTextCall = calls.find((c) => c[0] === 'fillText');
    // Full title, never truncated, drawn at the placed (left) x — not sigma's stock always-right
    // position of data.x + data.size + 3.
    expect(fillTextCall![1]).toBe('A Much Longer Node Title');
    expect(fillTextCall![2]).toBe(190 - 10 - 3);
  });
});
