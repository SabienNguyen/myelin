// @vitest-environment jsdom
// The anki badge's whole point is a conditional: a `down` Anki is SILENT (nobody installed it, an
// amber "problem" badge for a feature they never asked for reads as broken), while `backlog` and
// `up` are worth surfacing. That guard (`status.anki && status.anki !== 'down'`) is exactly the kind
// of thing a later "simplification" drops — these pin it, plus the accessible name each state
// carries (the dot's colour is aria-hidden, so the label is the only non-visual carrier of state).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { TopbarStatus } from '../../src/client/components/TopbarStatus.js';

function stubStatus(status: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  // /api/status on mount; StudentSwitcher fetches /api/students & /api/voice on open. `extra` lets
  // a test seed those (e.g. a students list) — otherwise they resolve to {}.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.endsWith('/api/status') ? status
      : u.endsWith('/api/students') ? (extra.students ?? {})
        : u.endsWith('/api/voice') ? (extra.voice ?? {})
          : {};
    return { ok: true, json: async () => body };
  }) as any);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TopbarStatus — the Anki badge is shown only when it says something useful', () => {
  it('a review backlog surfaces an amber badge named for the backlog', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sonnet-5', anki: 'backlog' });
    render(<TopbarStatus />);
    const badge = await screen.findByLabelText('Anki has a review backlog');
    expect(badge.className).toContain('anki-backlog');
    expect(badge.getAttribute('role')).toBe('status');
  });

  it('a connected Anki reads as connected', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sonnet-5', anki: 'up' });
    render(<TopbarStatus />);
    const badge = await screen.findByLabelText('Anki connected');
    expect(badge.className).toContain('anki-up');
  });

  it('a closed Anki shows NO badge — down is silent, not greyed', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sonnet-5', anki: 'down' });
    render(<TopbarStatus />);
    // The tutor badge proves the status fetch resolved and the bar rendered…
    await screen.findByText('Sonnet 5');
    // …and yet nothing anki is on screen.
    expect(screen.queryByLabelText(/anki/i)).toBeNull();
    expect(document.querySelector('[class*="anki-"]')).toBeNull();
  });

  it('an absent anki field shows no badge either', async () => {
    stubStatus({ student: 'e2e', tutor: 'claude-sonnet-5' });
    render(<TopbarStatus />);
    await screen.findByText('Sonnet 5');
    await waitFor(() => expect(document.querySelector('[class*="anki-"]')).toBeNull());
  });
});

describe('StudentSwitcher — a popup with inputs is a dialog, not a menu', () => {
  // It holds two text inputs (teaching style, new student) beside the student buttons. ARIA forbids
  // a text field inside role="menu", and role="menu" advertises the arrow-key model this popup never
  // implemented. It must announce as a dialog (like AddMaterial, its structural twin), and the
  // student options must NOT carry role="menuitem" (which would re-assert the menu contract).
  it('opens a dialog, and the student options are plain buttons — no menu roles anywhere', async () => {
    stubStatus(
      { student: 'e2e', tutor: 'claude-sonnet-5' },
      { students: { current: 'e2e', students: ['e2e', 'alex'] }, voice: { voice: '' } },
    );
    render(<TopbarStatus />);
    const trigger = await screen.findByRole('button', { name: /switch student/i });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // The popup announces as a dialog…
    const dialog = await screen.findByRole('dialog', { name: /switch student/i });
    expect(dialog).toBeTruthy();
    // …a switch target renders (proving the students fetch resolved into the popup)…
    await screen.findByRole('button', { name: /alex/i });
    // …and nothing inside claims to be a menu or a menu item.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });
});
