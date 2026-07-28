// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ImeInput, imeFor } from '../../src/client/components/blocks/ImeInput.js';

afterEach(cleanup);

// ImeInput lets a learner type a target language from an ASCII keyboard. The keydown buffer is
// the crux: the field shows the transliteration while holding the raw keystrokes, and submits the
// transliterated value — so a Vietnamese answer is graded as the learner meant it, not as ASCII.
describe('imeFor — method selection by BCP-47 primary subtag', () => {
  it('resolves Vietnamese and Mandarin, ignores region, and returns undefined for the unsupported', () => {
    expect(imeFor('vi')?.label).toBe('Telex');
    expect(imeFor('vi-VN')?.label).toBe('Telex');
    expect(imeFor('zh')?.label).toBe('Pinyin');
    expect(imeFor('zh-CN')?.label).toBe('Pinyin');
    expect(imeFor('en')).toBeUndefined();
    expect(imeFor(undefined)).toBeUndefined();
  });

  it('types pinyin tone numbers: ni3 → nǐ', () => {
    const onSubmit = vi.fn();
    render(<ImeInput name="a" lang="zh" onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/Pinyin input/) as HTMLInputElement;
    for (const ch of 'ni3') fireEvent.keyDown(input, { key: ch });
    expect(input.value).toBe('nǐ');
  });
});

describe('ImeInput — Telex typing submits the transliterated value', () => {
  it('types vieejt and submits việt', () => {
    const onSubmit = vi.fn();
    render(<ImeInput name="a" lang="vi" onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/Telex input/) as HTMLInputElement;
    for (const ch of 'Vieejt') fireEvent.keyDown(input, { key: ch });
    expect(input.value).toBe('Việt');
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledWith('Việt');
  });

  it('backspace pops the raw buffer, re-deriving the display', () => {
    render(<ImeInput name="a" lang="vi" onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/Telex input/) as HTMLInputElement;
    for (const ch of 'nhaf') fireEvent.keyDown(input, { key: ch });
    expect(input.value).toBe('nhà');
    fireEvent.keyDown(input, { key: 'Backspace' }); // drop the tone key → plain a
    expect(input.value).toBe('nha');
  });

  it('an unsupported language renders a plain input with no toggle', () => {
    render(<ImeInput name="a" lang="en" onSubmit={vi.fn()} />);
    expect(screen.queryByText(/Telex/)).toBeNull();
  });

  it('the toggle drops back to a plain field for system-IME / paste', () => {
    render(<ImeInput name="a" lang="vi" onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByText(/Telex on/));
    expect(screen.getByText(/Telex off/)).toBeTruthy();
  });
});
