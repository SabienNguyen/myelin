// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { initScheme, chooseScheme, currentScheme } from '../../src/client/lib/theme.js';
import { ThemeToggle } from '../../src/client/components/ThemeToggle.js';

// An OS whose scheme the test can flip, firing the change listeners the way a browser does.
function fakeOs(initial: 'light' | 'dark') {
  let light = initial === 'light';
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query === '(prefers-color-scheme: light)' ? light : false; },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }));
  return { set(scheme: 'light' | 'dark') { light = scheme === 'light'; for (const cb of listeners) cb(); } };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

describe('colour scheme', () => {
  it('follows the OS until the learner picks one', () => {
    const os = fakeOs('light');
    initScheme();
    expect(currentScheme()).toBe('light');
    os.set('dark');
    expect(currentScheme()).toBe('dark');
  });

  it('keeps a picked scheme across a reload and over an OS change', () => {
    const os = fakeOs('dark');
    initScheme();
    chooseScheme('light');
    delete document.documentElement.dataset.theme;
    initScheme();
    expect(currentScheme()).toBe('light');
    os.set('dark');
    expect(currentScheme()).toBe('light');
  });

  it('the topbar toggle flips the page and names the scheme it switches to', () => {
    fakeOs('dark');
    initScheme();
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
