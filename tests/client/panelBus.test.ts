import { describe, it, expect } from 'vitest';
import { panelBus, wikiPreprocess, scrubModelArtifacts, chatPreprocess, escapeLooseDollars, mathDelims } from '../../src/client/lib/panelBus.js';

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
  it('leaves [[…]] verbatim inside code — the wiki-link syntax shown AS CODE is not a link', () => {
    // A lesson about wiki/Obsidian markup shows `[[note]]` literally; it must not become a link.
    expect(wikiPreprocess('link with `[[note-name]]` syntax')).toBe('link with `[[note-name]]` syntax');
    expect(wikiPreprocess('```\nsee [[x]]\n```')).toBe('```\nsee [[x]]\n```');
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

describe('escapeLooseDollars', () => {
  it('escapes the exact banked-problem currency pair that KaTeX ate in the live sitting', () => {
    expect(escapeLooseDollars('An asset bought for $12,000 is sold for $19,500 after 14 months.'))
      .toBe('An asset bought for \\$12,000 is sold for \\$19,500 after 14 months.');
  });

  it('escapes a run of currency amounts none of which can close a math span', () => {
    expect(escapeLooseDollars('income of $58,000. Using brackets of 10% up to $11,000, 12% up to $44,725'))
      .toBe('income of \\$58,000. Using brackets of 10% up to \\$11,000, 12% up to \\$44,725');
  });

  it('keeps real inline math untouched', () => {
    expect(escapeLooseDollars('the formula $C_1V_1 = C_2V_2$ requires molarity'))
      .toBe('the formula $C_1V_1 = C_2V_2$ requires molarity');
  });

  it('escapes a lone trailing dollar and a postfix dollar', () => {
    expect(escapeLooseDollars('costs 50$ plus $5.')).toBe('costs 50\\$ plus \\$5.');
  });

  it('will not close a span on a dollar that is followed by a digit', () => {
    // Pandoc's digit rule: the "$" before 19 could otherwise close the span opened before 12.
    expect(escapeLooseDollars('$12,000 and $19,500')).toBe('\\$12,000 and \\$19,500');
  });

  it('leaves code spans, fences and display math alone', () => {
    const md = 'run `echo $HOME` and\n```sh\n$PATH is $set\n```\nand $$a b$$ stays';
    expect(escapeLooseDollars(md)).toBe(md);
  });

  it('passes already-escaped dollars through unchanged', () => {
    expect(escapeLooseDollars('literal \\$5 stays')).toBe('literal \\$5 stays');
  });
});

describe('mathDelims', () => {
  it('converts LaTeX \\(inline\\) and \\[display\\] to $-delimiters', () => {
    expect(mathDelims('the rule \\( f(x) = 3x^2 \\) holds')).toBe('the rule $ f(x) = 3x^2 $ holds');
    expect(mathDelims('block: \\[ E = mc^2 \\] there')).toBe('block: \n$$\n E = mc^2 \n$$\n there');
  });

  it('leaves \\[ / \\( verbatim inside a code span — the delimiter shown AS CODE is not math', () => {
    // A LaTeX-syntax lesson: `\[` must render as the literal delimiter, not be rewritten into a $$
    // block (which also injected newlines that break the code span).
    const md = 'To open display math type `\\[` and close with `\\]`.';
    expect(mathDelims(md)).toBe(md);
    expect(mathDelims('example `\\[ E = mc^2 \\]` here')).toBe('example `\\[ E = mc^2 \\]` here');
  });

  it('leaves delimiters verbatim inside a fenced code block', () => {
    const md = '```latex\n\\[ x^2 \\]\n```';
    expect(mathDelims(md)).toBe(md);
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
