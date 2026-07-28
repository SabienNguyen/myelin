// @vitest-environment jsdom
// The anki badge's whole point is a conditional: a `down` Anki is SILENT (nobody installed it, an
// amber "problem" badge for a feature they never asked for reads as broken), while `backlog` and
// `up` are worth surfacing. That guard (`status.anki && status.anki !== 'down'`) is exactly the kind
// of thing a later "simplification" drops — these pin it, plus the accessible name each state
// carries (the dot's colour is aria-hidden, so the label is the only non-visual carrier of state).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { TopbarStatus } from '../../src/client/components/TopbarStatus.js';

function stubStatus(status: Record<string, unknown>) {
  // Only /api/status matters on mount; StudentSwitcher fetches /api/students & /api/voice lazily
  // (on open), so a catch-all that answers status and returns {} elsewhere is enough here.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).endsWith('/api/status') ? status : {}),
  })) as any);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TopbarStatus — the Anki badge is shown only when it says something useful', () => {
  it('a review backlog surfaces an amber badge named for the backlog', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sdk:sonnet', anki: 'backlog' });
    render(<TopbarStatus />);
    const badge = await screen.findByLabelText('Anki has a review backlog');
    expect(badge.className).toContain('anki-backlog');
    expect(badge.getAttribute('role')).toBe('status');
  });

  it('a connected Anki reads as connected', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sdk:sonnet', anki: 'up' });
    render(<TopbarStatus />);
    const badge = await screen.findByLabelText('Anki connected');
    expect(badge.className).toContain('anki-up');
  });

  it('a closed Anki shows NO badge — down is silent, not greyed', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sdk:sonnet', anki: 'down' });
    render(<TopbarStatus />);
    // The tutor badge proves the status fetch resolved and the bar rendered…
    await screen.findByText('Sonnet');
    // …and yet nothing anki is on screen.
    expect(screen.queryByLabelText(/anki/i)).toBeNull();
    expect(document.querySelector('[class*="anki-"]')).toBeNull();
  });

  it('an absent anki field shows no badge either', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sdk:sonnet' });
    render(<TopbarStatus />);
    await screen.findByText('Sonnet');
    await waitFor(() => expect(document.querySelector('[class*="anki-"]')).toBeNull());
  });
});
