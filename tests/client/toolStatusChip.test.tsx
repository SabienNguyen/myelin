// @vitest-environment jsdom
// The transcript's quiet tool marginalia must not misreport outcomes: a FAILED record_evidence
// once rendered "✗ evidence recorded" — success copy under a failure mark, caught on an audit
// screenshot. These pin that the failed column of the label table is actually used.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
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

  it('falls back honestly for a tool with no label entry', () => {
    const { container } = render(
      <ToolStatusChip toolName="mystery_tool" result={{ isError: true }} />,
    );
    expect(container.textContent).toBe('✗ mystery_tool failed');
  });
});
