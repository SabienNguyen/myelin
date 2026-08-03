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

/**
 * A `speak` block whose `lang` is missing used to white-screen the page:
 * "Cannot read properties of undefined (reading 'toLowerCase')" thrown out of pickVoice, caught
 * live while asking a PyTorch tutor for a Vietnamese word. The schema marks lang required, but
 * nothing validates a model-staged block before it reaches the client (rails parses its own
 * blocks; the agentic path does not), so bad model output became a React crash. A missing voice
 * tag must degrade to "no voice", which is already the no-matching-voice behaviour.
 */
describe('pickVoice with a missing language tag', () => {
  it('returns null instead of throwing', () => {
    const voices = [{ lang: 'vi-VN' }, { lang: 'en-US' }];
    expect(pickVoice(voices, undefined as unknown as string)).toBeNull();
    expect(pickVoice(voices, '' as unknown as string)).toBeNull();
  });

  it('still picks a matching voice when the tag is present', () => {
    expect(pickVoice([{ lang: 'en-US' }, { lang: 'vi-VN' }], 'vi')).toEqual({ lang: 'vi-VN' });
  });
});
