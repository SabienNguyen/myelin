// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { initScheme, chooseScheme, currentScheme } from '../../src/client/lib/theme.js';
import { ThemeChoice } from '../../src/client/components/ThemeToggle.js';

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

  it('the settings choice sets the page\'s scheme and shows which one is on', () => {
    fakeOs('dark');
    initScheme();
    render(<ThemeChoice />);
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
