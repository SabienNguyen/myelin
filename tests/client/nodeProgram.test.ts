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
const { MasteryNodeProgram } = await import('../../src/client/graph/nodeProgram.js');

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
