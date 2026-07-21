import { describe, it, expect } from 'vitest';
import { panelBus, wikiPreprocess, scrubModelArtifacts, chatPreprocess } from '../../src/client/lib/panelBus.js';

describe('panelBus', () => {
  it('notifies subscribers of page opens', () => {
    const seen: any[] = [];
    const un = panelBus.subscribe((e) => seen.push(e));
    panelBus.openPage('chain-rule');
    un();
    expect(seen).toEqual([{ type: 'openPage', slug: 'chain-rule' }]);
  });
});

describe('wikiPreprocess', () => {
  it('rewrites wiki links with and without labels', () => {
    expect(wikiPreprocess('see [[chain-rule]] and [[loss-functions|losses]]'))
      .toBe('see [chain-rule](#/page/chain-rule) and [losses](#/page/loss-functions)');
  });
});

describe('scrubModelArtifacts', () => {
  it('cleans the exact user-reported leaked-ChatML string to readable text', () => {
    const dirty = '…just share any ideas or thoughts you have. -valu <|im_start|> ' +
      '<|im_start|>🤓 Sure thing! … -valu <|im_start|> <|im_start|>assistant Great! ' +
      "Let's start…";
    const clean = scrubModelArtifacts(dirty);
    expect(clean).not.toContain('<|');
    expect(clean).not.toMatch(/im_start|im_end/);
    expect(clean).not.toMatch(/ {2,}/);
    expect(clean).toMatch(/Sure thing!/);
    expect(clean).toMatch(/Great! Let's start/);
  });

  it('removes <|endoftext|>', () => {
    expect(scrubModelArtifacts('the end <|endoftext|> of the answer'))
      .toBe('the end of the answer');
  });

  it('removes unknown <|foo_bar|>-shaped markers', () => {
    expect(scrubModelArtifacts('before <|foo_bar|> after')).toBe('before after');
  });

  it('strips a role word immediately following im_start/im_end', () => {
    expect(scrubModelArtifacts('<|im_start|>assistant Hello there<|im_end|>'))
      .toBe('Hello there');
    expect(scrubModelArtifacts('<|im_start|>user What is 2+2?<|im_end|>'))
      .toBe('What is 2+2?');
  });

  it('leaves legitimate text with a pipe or an HTML-ish tag untouched', () => {
    expect(scrubModelArtifacts('a table cell: `a | b` and some <code>x</code>'))
      .toBe('a table cell: `a | b` and some <code>x</code>');
  });

  it('collapses blank-line runs left behind down to at most 2 newlines', () => {
    const dirty = 'line one\n<|im_start|>\n\n\n\nline two';
    expect(scrubModelArtifacts(dirty)).toBe('line one\n\nline two');
  });

  it('does not mangle math delimiters or plain text with no artifacts', () => {
    expect(scrubModelArtifacts('\\(x^2\\) and normal text')).toBe('\\(x^2\\) and normal text');
  });
});

describe('chatPreprocess composition', () => {
  it('scrubs model artifacts before/alongside wiki links and math delims', () => {
    const dirty = '<|im_start|>assistant see [[chain-rule]] and \\(x^2\\)<|im_end|>';
    const out = chatPreprocess(dirty);
    expect(out).not.toContain('<|');
    expect(out).toContain('[chain-rule](#/page/chain-rule)');
    expect(out).toContain('$x^2$');
  });
});
