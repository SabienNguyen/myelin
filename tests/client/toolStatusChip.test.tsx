// @vitest-environment jsdom
// The transcript's quiet tool marginalia must not misreport outcomes: a FAILED record_evidence
// once rendered "✗ evidence recorded" — success copy under a failure mark, caught on an audit
// screenshot. These pin that the failed column of the label table is actually used.
//
// The page-naming tests use the shapes production sends: a read_page result is an MCP envelope
// (`{ content: [{ type: 'text', text: '<JSON>' }] }`) whose title the chip parses, and a
// record_evidence result carries no title, so that chip takes the page's title from /api/graph
// via usePageTitle. The graph tests import ToolStatusChip fresh (vi.resetModules()) because
// pageTitles.ts's cache is a module-level singleton, throttled across every caller.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ToolStatusChip } from '../../src/client/components/ToolStatusChip.js';
import { panelBus } from '../../src/client/lib/panelBus.js';

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

  it('names the page a read_page chip acted on from its MCP result, and opens it in the Page tab', () => {
    const seen: string[] = [];
    const off = panelBus.subscribe((e) => { if (e.type === 'openPage') seen.push(e.slug); });
    const { container } = render(
      <ToolStatusChip
        toolName="read_page" args={{ slug: 'chain-rule' }}
        result={{ content: [{ type: 'text', text: JSON.stringify({ page: { slug: 'chain-rule', meta: { title: 'Chain rule' } } }) }] }}
      />,
    );
    expect(container.textContent).toBe('read Chain rule');
    fireEvent.click(screen.getByRole('button', { name: 'Chain rule' }));
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

  it('scrubs leaked control tokens from a page title', () => {
    const { container } = render(
      <ToolStatusChip toolName="write_page" args={{ slug: 'limits', title: '<|im_start|>assistant\nLimits' }} result={{ content: [] }} />,
    );
    expect(container.textContent).toBe('wrote Limits');
  });

  it('shows an unfinished call as pending, with no page link', () => {
    const { container } = render(<ToolStatusChip toolName="record_evidence" args={{ slug: 'limits' }} />);
    expect(container.textContent).toBe('recording evidence…');
    expect(container.querySelector('button')).toBeNull();
  });
});
