// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Speak } from '../../src/client/components/blocks/Speak.js';

// The speak control's WHOLE justification is honesty about audio: if the device has no voice for
// the language, it must say so rather than mispronounce in the wrong accent, and it must report
// that back so the tutor can adapt. pickVoice is unit-tested separately; this pins the React
// behavior — which branch renders, and that the availability receipt fires exactly once.

class FakeUtterance {
  text: string; voice: any = null; lang = ''; rate = 1;
  onend: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

function installSynth(voices: { lang: string; name: string }[]) {
  const speak = vi.fn();
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance as any;
  (window as any).speechSynthesis = {
    getVoices: () => voices,
    speak,
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return speak;
}

afterEach(() => { delete (window as any).speechSynthesis; });

describe('Speak — honesty about whether audio is actually available', () => {
  let addResult: ReturnType<typeof vi.fn>;
  beforeEach(() => { addResult = vi.fn(); });

  it('no matching voice → the degrade-loudly chip, and reports available:false once', async () => {
    installSynth([{ lang: 'en-US', name: 'English' }]);
    render(<Speak args={{ text: 'mạ', lang: 'vi', gloss: 'rice seedling' }} result={null} addResult={addResult} />);

    await waitFor(() => expect(screen.getByText(/no vi voice on this device/i)).toBeTruthy());
    // It still shows the word and gloss so the lesson reads, just without a play button.
    expect(screen.getByText('mạ')).toBeTruthy();
    expect(screen.getByText('rice seedling')).toBeTruthy();
    await waitFor(() => expect(addResult).toHaveBeenCalledWith({ available: false, spoke: 'mạ' }));
    expect(addResult).toHaveBeenCalledTimes(1);
  });

  it('a matching voice → a real play button that speaks, and reports available:true', async () => {
    const speak = installSynth([{ lang: 'vi-VN', name: 'Vietnamese' }]);
    render(<Speak args={{ text: 'má', lang: 'vi' }} result={null} addResult={addResult} />);

    const btn = await screen.findByRole('button', { name: /hear "má"/i });
    expect(btn).toBeTruthy();
    await waitFor(() => expect(addResult).toHaveBeenCalledWith({ available: true, spoke: 'má' }));

    fireEvent.click(btn);
    expect(speak).toHaveBeenCalledTimes(1);
    const utter = speak.mock.calls[0][0] as FakeUtterance;
    expect(utter.text).toBe('má');
    expect(utter.voice).toEqual({ lang: 'vi-VN', name: 'Vietnamese' });
  });

  it('once a result exists, it does not re-report (receipt is one-shot)', async () => {
    installSynth([{ lang: 'en-US', name: 'English' }]);
    render(<Speak args={{ text: 'ma', lang: 'vi' }} result={{ available: false }} addResult={addResult} />);
    // Give the availability effect a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(addResult).not.toHaveBeenCalled();
  });
});
