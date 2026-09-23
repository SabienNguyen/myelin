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
});
