// @vitest-environment jsdom
// The transcript's quiet tool marginalia must not misreport outcomes: a FAILED record_evidence
// once rendered "✗ evidence recorded" — success copy under a failure mark, caught on an audit
// screenshot. These pin that the failed column of the label table is actually used.
//
// The page-naming tests use the REAL shapes production sends, not a convenient stand-in: a
// read_page result is an MCP envelope (`{ content: [{ type: 'text', text: '<JSON>' }] }`), and the
// title comes from a stubbed /api/graph via usePageTitle — never from parsing that envelope. An
// earlier version of this file passed a hand-shaped `{ page: { meta: { title } } }` result that
// production never produces, which is why the chip's fallback-to-slug bug survived a passing suite.
//
// Those two tests import ToolStatusChip (and panelBus, for the click-through test) fresh via
// vi.resetModules() rather than the file's top-level import. pageTitles.ts's cache is a
// module-level singleton throttled to one /api/graph call per 15s across every caller — the
// throttle is shared by whichever test asks first, in THIS file and any other client test file
// Vitest happens to run in the same process. A fresh module per test sidesteps that instead of
// betting on suite-wide execution order and timing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ToolStatusChip } from '../../src/client/components/ToolStatusChip.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Stubs /api/graph (via getGraph -> getJson -> fetch) with a fixed node list, Response-like
 *  enough for getJson's ok/status/json contract. */
function stubGraph(nodes: Array<{ slug: string; title: string }>) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ nodes }),
  })));
}

/** A fresh ToolStatusChip + panelBus pair from a fresh module graph, so this test's usePageTitle
 *  cache (and the throttle inside it) starts cold regardless of what any other test — in this
 *  file or another — already asked for. */
async function freshChip() {
  vi.resetModules();
  const [chip, bus] = await Promise.all([
    import('../../src/client/components/ToolStatusChip.js'),
    import('../../src/client/lib/panelBus.js'),
  ]);
  return { ToolStatusChip: chip.ToolStatusChip, panelBus: bus.panelBus };
}

describe('ToolStatusChip', () => {
  it('reports success in the past tense', () => {
    const { container } = render(<ToolStatusChip toolName="record_evidence" result={{ ok: true }} />);
    expect(container.textContent).toBe('evidence recorded');
  });

  it('reports failure as NOT done — never success copy under an ✗', () => {
    const { container } = render(
      <ToolStatusChip toolName="record_evidence" result={{ isError: true, content: [] }} />,
    );
    expect(container.textContent).toBe('✗ evidence not recorded');
    expect(container.querySelector('.tool-note.failed')).toBeTruthy();
  });

  it('labels create_path — a cold-start sitting watched it leak as raw "CREATE_PATH"', () => {
    const { container } = render(<ToolStatusChip toolName="create_path" result={{ ok: true }} />);
    expect(container.textContent).toBe('created a path');
  });

  it('labels the Agent SDK web tools under their unstripped names', () => {
    const { container } = render(<ToolStatusChip toolName="WebSearch" result={{ ok: true }} />);
    expect(container.textContent).toBe('searched the web');
  });

  it('falls back honestly for a tool with no label entry', () => {
    const { container } = render(
      <ToolStatusChip toolName="mystery_tool" result={{ isError: true }} />,
    );
    expect(container.textContent).toBe('✗ mystery_tool failed');
  });

  it('names the page a page tool acted on and opens it in the Page tab — from the graph, not the MCP envelope', async () => {
    stubGraph([{ slug: 'chain-rule', title: 'Chain rule' }]);
    const { ToolStatusChip: FreshChip, panelBus: freshBus } = await freshChip();
    const seen: string[] = [];
    const off = freshBus.subscribe((e) => { if (e.type === 'openPage') seen.push(e.slug); });
    // The real shape a read_page result reaches the client in: an MCP envelope whose title is
    // buried in a JSON-encoded text blob, not the parsed object a naive `result.page.meta.title`
    // read expects. The chip must ignore this entirely and resolve the title from the graph.
    const result = {
      content: [{ type: 'text', text: JSON.stringify({ page: { slug: 'chain-rule', meta: { title: 'Chain rule' } } }) }],
    };
    const { container } = render(<FreshChip toolName="read_page" args={{ slug: 'chain-rule' }} result={result} />);
    // The title arrives async (the graph fetch), so this must wait rather than assert immediately.
    const link = await screen.findByRole('button', { name: 'Chain rule' });
    expect(container.textContent).toBe('read Chain rule');
    fireEvent.click(link);
    expect(seen).toEqual(['chain-rule']);
    off();
  });

  it('a record_evidence chip names its page by title from the graph', async () => {
    stubGraph([{ slug: 'derivative-rules', title: 'Derivative rules' }]);
    const { ToolStatusChip: FreshChip } = await freshChip();
    const { container } = render(<FreshChip toolName="record_evidence" args={{ slug: 'derivative-rules' }} result={{ ok: true }} />);
    await screen.findByRole('button', { name: 'Derivative rules' });
    expect(container.textContent).toBe('evidence recorded on Derivative rules');
  });

  it('falls back to the slug read as words when the graph has nothing for it', () => {
    const { container } = render(<ToolStatusChip toolName="record_evidence" args={{ slug: 'epsilon-delta' }} result={{ ok: true }} />);
    expect(container.textContent).toBe('evidence recorded on epsilon delta');
  });

  it('reads a thrown tool (the isError prop, result { error }) as a failure too', () => {
    const { container } = render(
      <ToolStatusChip toolName="record_evidence" args={{ slug: 'limits' }} result={{ error: 'boom' }} isError />,
    );
    expect(container.textContent).toBe('✗ evidence not recorded');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the plain failure copy — a failed read names no page as if it were read', () => {
    const { container } = render(<ToolStatusChip toolName="read_page" args={{ slug: 'x' }} result={{ isError: true }} />);
    expect(container.textContent).toBe('✗ could not read the page');
    expect(container.querySelector('button')).toBeNull();
  });
});
