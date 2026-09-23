// @vitest-environment jsdom
// The transcript's quiet tool marginalia must not misreport outcomes: a FAILED record_evidence
// once rendered "✗ evidence recorded" — success copy under a failure mark, caught on an audit
// screenshot. These pin that the failed column of the label table is actually used.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { panelBus } from '../../src/client/lib/panelBus.js';
import { ToolStatusChip } from '../../src/client/components/ToolStatusChip.js';

describe('ToolStatusChip', () => {
  afterEach(cleanup);

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

  it('names the page a page tool acted on and opens it in the Page tab', () => {
    const seen: string[] = [];
    const off = panelBus.subscribe((e) => { if (e.type === 'openPage') seen.push(e.slug); });
    const { container } = render(
      <ToolStatusChip toolName="read_page" args={{ slug: 'chain-rule' }} result={{ page: { meta: { title: 'Chain rule' } } }} />,
    );
    expect(container.textContent).toBe('read Chain rule');
    fireEvent.click(screen.getByRole('button', { name: 'Chain rule' }));
    expect(seen).toEqual(['chain-rule']);
    off();
  });

  it('falls back to the slug read as words when the call carries no title', () => {
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
