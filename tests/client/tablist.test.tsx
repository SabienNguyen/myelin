// @vitest-environment jsdom
//
// The APG tabs pattern is half declarative and half behavioural, and the behavioural half is the
// half that silently rots: all three strips shipped with role="tab" + aria-selected and no keyboard
// handling at all, which announces a widget the keyboard cannot drive. These tests pin the
// behaviour, not the markup — the markup was never the part that was missing.
//
// Scope note, deliberately: jsdom implements neither Tab traversal nor caret movement, so two
// claims cannot honestly be made here — that one Tab press LEAVES the strip, and that arrow keys
// still move a composer caret. Both were verified against real key presses in Chromium
// (scratchpad/tablist-probe.mjs). What this file pins is the mechanism those two rest on: the
// roving tabindex, and the handler declining every key it does not own.

import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useRovingKeys, useTablistKeys } from '../../src/client/lib/tablist.js';

afterEach(cleanup);

const TABS = ['stage', 'graph', 'page', 'library'] as const;

function Strip() {
  const onKeys = useTablistKeys();
  const [active, setActive] = useState<string>('stage');
  return (
    <nav role="tablist" aria-label="Workspace panels" onKeyDown={onKeys} data-testid="strip">
      {TABS.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={t === active}
          tabIndex={t === active ? 0 : -1}
          onClick={() => setActive(t)}
        >{t}</button>
      ))}
    </nav>
  );
}

const strip = () => screen.getByTestId('strip');
const tab = (name: string) => screen.getByRole('tab', { name });
const selected = () => screen.getByRole('tab', { selected: true }).textContent;
const focused = () => (document.activeElement as HTMLElement)?.textContent;
const tabbable = () => screen.getAllByRole('tab')
  .filter((el) => (el as HTMLElement).tabIndex === 0)
  .map((el) => el.textContent);

/** Focus a tab and send a key to the strip, the way a real keydown bubbles from the focused tab. */
function press(from: string, key: string) {
  tab(from).focus();
  fireEvent.keyDown(strip(), { key });
}

describe('useTablistKeys', () => {
  it('ArrowRight moves focus AND selection to the next tab', () => {
    render(<Strip />);
    press('stage', 'ArrowRight');
    expect(focused()).toBe('graph');
    // Automatic activation: focus selects. Manual activation would make the keyboard path strictly
    // worse than the mouse path — an extra Enter to reveal an already-mounted panel.
    expect(selected()).toBe('graph');
  });

  it('ArrowLeft wraps backwards from the first tab to the last', () => {
    render(<Strip />);
    press('stage', 'ArrowLeft');
    expect(focused()).toBe('library');
    expect(selected()).toBe('library');
  });

  it('ArrowRight wraps forwards from the last tab to the first', () => {
    render(<Strip />);
    press('library', 'ArrowRight');
    expect(focused()).toBe('stage');
  });

  it('Home and End jump to the ends', () => {
    render(<Strip />);
    press('graph', 'End');
    expect(focused()).toBe('library');
    fireEvent.keyDown(strip(), { key: 'Home' });
    expect(focused()).toBe('stage');
  });

  it('keeps exactly one tab in the page tab order', () => {
    render(<Strip />);
    // This is what makes a single Tab press leave the strip instead of walking all four tabs —
    // without it the arrow keys are redundant rather than necessary.
    expect(tabbable()).toEqual(['stage']);
  });

  it('moves the roving tabindex along with the selection', () => {
    render(<Strip />);
    press('stage', 'ArrowRight');
    fireEvent.keyDown(strip(), { key: 'ArrowRight' });
    expect(selected()).toBe('page');
    // If the tabindex did not follow, Tab would re-enter the strip at whichever tab was selected
    // when the component first mounted.
    expect(tabbable()).toEqual(['page']);
  });

  it('ignores keys it does not own', () => {
    render(<Strip />);
    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'a', 'Enter']) {
      press('stage', key);
      expect(focused()).toBe('stage');
      expect(selected()).toBe('stage');
    }
  });

  it('does not steer when focus is outside the tabs', () => {
    render(<Strip />);
    // A handler that acted on any arrow press reaching the strip — rather than only when a tab is
    // focused — would swallow caret movement for anything ever nested inside a tablist.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(strip(), { key: 'ArrowRight' });
    expect(selected()).toBe('stage');
  });
});

// ── useRovingKeys: the graph's variant ───────────────────────────────────────
//
// The graph is the same roving-focus contract with two settings flipped: vertical arrows also move
// (a graph has no reading axis), and focus must NOT activate — arrowing across nodes would
// otherwise fire a page navigation on every keypress.

function Nodes() {
  const onKeys = useRovingKeys({ selector: '.node', orientation: 'both', activateOnFocus: false });
  const [opened, setOpened] = useState<string[]>([]);
  const [current, setCurrent] = useState('a');
  return (
    <div>
      <div role="group" onKeyDown={onKeys} data-testid="nodes">
        {['a', 'b', 'c'].map((k) => (
          <span
            key={k}
            role="link"
            className="node"
            tabIndex={current === k ? 0 : -1}
            onClick={() => { setCurrent(k); setOpened((o) => [...o, k]); }}
          >{k}</span>
        ))}
      </div>
      <div data-testid="opened">{opened.join(',')}</div>
    </div>
  );
}

describe('useRovingKeys (graph nodes)', () => {
  it('moves on vertical arrows too', () => {
    render(<Nodes />);
    screen.getByText('a').focus();
    fireEvent.keyDown(screen.getByTestId('nodes'), { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('b');
    fireEvent.keyDown(screen.getByTestId('nodes'), { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('a');
  });

  it('does not activate the item it focuses', () => {
    render(<Nodes />);
    screen.getByText('a').focus();
    fireEvent.keyDown(screen.getByTestId('nodes'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByTestId('nodes'), { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('c');
    // Automatic activation here would have navigated the Page panel twice on the way past.
    expect(screen.getByTestId('opened').textContent).toBe('');
  });
});
