import { describe, it, expect } from 'vitest';
import { pickVoice } from '../../src/client/components/blocks/Speak.js';

// The speak control (Speak.tsx) exists because a text tutor could teach the Vietnamese tone MAP
// but never let the learner hear it (a live sitting named the gap). Voice selection must match by
// BCP-47 primary subtag so "vi" finds the OS's "vi-VN" voice, prefer an exact tag, and return
// null when nothing matches — the honest signal that drives the degrade-loudly path.
const V = (lang: string, name = lang) => ({ lang, name });

describe('pickVoice — BCP-47 matching for the speak control', () => {
  it('matches by primary subtag: "vi" finds vi-VN', () => {
    expect(pickVoice([V('en-US'), V('vi-VN'), V('fr-FR')], 'vi')?.lang).toBe('vi-VN');
  });

  it('prefers an exact tag over a primary-subtag sibling', () => {
    const voices = [V('zh-TW'), V('zh-CN'), V('en-US')];
    expect(pickVoice(voices, 'zh-CN')?.lang).toBe('zh-CN');
  });

  it('tolerates underscore locale forms (vi_VN)', () => {
    expect(pickVoice([V('vi_VN')], 'vi')?.lang).toBe('vi_VN');
  });

  it('returns null when no voice matches — the degrade-loudly signal', () => {
    expect(pickVoice([V('en-US'), V('fr-FR')], 'vi')).toBeNull();
  });

  it('is case-insensitive on both sides', () => {
    expect(pickVoice([V('VI-vn')], 'Vi-VN')?.lang).toBe('VI-vn');
  });
});
