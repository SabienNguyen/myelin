import { describe, it, expect } from 'vitest';
import { panelBus, wikiPreprocess, scrubModelArtifacts, chatPreprocess, escapeLooseDollars, mathDelims, citationLinks } from '../../src/client/lib/panelBus.js';

// OpenAI's citation markup (U+E200 "cite" U+E202 <ref> U+E201) has no glyph, so these fixtures
// build it from numeric escapes rather than embedding the real characters directly — an embedded
// one would be invisible in this file too, indistinguishable from simply being absent.
const CITE_OPEN = String.fromCharCode(0xe200) + 'cite' + String.fromCharCode(0xe202);
const CITE_CLOSE = String.fromCharCode(0xe201);
const cite = (ref: string) => `${CITE_OPEN}${ref}${CITE_CLOSE}`;

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

describe('citationLinks', () => {
  it('turns the real saved-message sample into a link, keeping the one pre-existing space', () => {
    const dirty = `…instead of recomputing them each time. ${cite("Vault: The KV Cache: Why Generation Doesn't Recompute Everything")}`;
    expect(citationLinks(dirty)).toBe(
      "…instead of recomputing them each time. [The KV Cache: Why Generation Doesn't Recompute Everything]"
      + "(#/cite/The%20KV%20Cache%3A%20Why%20Generation%20Doesn't%20Recompute%20Everything)",
    );
  });

  it('produces the exact link for a short title too', () => {
    expect(citationLinks(`see ${cite('Vault: KV Cache')} here`))
      .toBe('see [KV Cache](#/cite/KV%20Cache) here');
  });

  it('drops an opaque web-search ref, and the space it leaves dangling before punctuation', () => {
    // web_search's own tool chip already shows this source — an opaque ref (turn0search0,
    // turn1view2, ...) has nothing for a link to point at.
    expect(citationLinks(`the results ${cite('turn0search0')}, that changes things.`))
      .toBe('the results, that changes things.');
  });

  it('drops an opaque ref with no adjacent punctuation, leaving exactly one space', () => {
    expect(citationLinks(`before ${cite('turn1view2')} after`)).toBe('before after');
  });

  it('leaves a citation inside a fenced code block untouched', () => {
    // A lesson that shows this exact markup AS CODE must not have it linkified or stripped —
    // same discipline PROTECTED_SPANS gives wikiPreprocess.
    const md = '```\n' + cite('Vault: Example') + '\n```';
    expect(citationLinks(md)).toBe(md);
  });

  it('entity-escapes brackets in the link text and encodes parentheses in the href', () => {
    // Unescaped, `[3]` in the title would end the markdown link's text early; an unescaped
    // `(old)` in the href would end its destination early. HTML entities (not backslash escapes)
    // because react-markdown decodes them back to the literal character in link text, whereas a
    // backslash escape survives into the rendered string and — worse — mathDelims (which runs
    // later in chatPreprocess) mistakes a `\[...\]` pair for LaTeX display math.
    expect(citationLinks(cite('Vault: Section [3](old)')))
      .toBe('[Section &#91;3&#93;(old)](#/cite/Section%20%5B3%5D%28old%29)');
  });

  it('entity-escapes a trailing backslash in the title instead of leaving a dangling escape', () => {
    // A raw trailing backslash in link text would escape the closing `]`, breaking the link.
    expect(citationLinks(cite('Vault: Weird Title\\')))
      .toBe('[Weird Title&#92;](#/cite/Weird%20Title%5C)');
  });

  it('drops only a same-line space before the marker, never a paragraph break', () => {
    // A dropped web ref at the start of a paragraph must not eat the blank line that separates
    // it from the previous one — CITATION_SPAN's lead group may only consume [ \t], not \n.
    const dirty = `para one\n\n${cite('turn0search0')} para two`;
    const out = citationLinks(dirty);
    expect(out.startsWith('para one\n\n')).toBe(true);
    expect(out).not.toContain('turn0search0');
  });

  it('inserts a separating space when the marker is glued directly onto a word', () => {
    expect(citationLinks(`recompute${cite('Vault: Caching')}.`))
      .toBe('recompute [Caching](#/cite/Caching).');
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

  it('strips a leftover citation span for a surface that never ran citationLinks', () => {
    expect(scrubModelArtifacts(`before ${cite('turn0search0')} after`)).toBe('before after');
  });

  it('strips a stray U+E200-U+E202 character from a marker missing its close', () => {
    expect(scrubModelArtifacts(`odd ${String.fromCharCode(0xe200)} dangling`)).toBe('odd dangling');
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

  it('runs citationLinks before scrubModelArtifacts, so the real sample becomes a link, not raw markers', () => {
    const dirty = `…instead of recomputing them each time. ${cite("Vault: The KV Cache: Why Generation Doesn't Recompute Everything")}`;
    expect(chatPreprocess(dirty)).toBe(
      "…instead of recomputing them each time. [The KV Cache: Why Generation Doesn't Recompute Everything]"
      + "(#/cite/The%20KV%20Cache%3A%20Why%20Generation%20Doesn't%20Recompute%20Everything)",
    );
  });

  it('drops an opaque citation through the full pipeline too', () => {
    const dirty = `found it here ${cite('turn0search0')}, apparently.`;
    expect(chatPreprocess(dirty)).toBe('found it here, apparently.');
  });

  it('keeps a bracketed title as one intact cite link, not display math', () => {
    // Regression: citationLinks used to backslash-escape `[`/`]`, and mathDelims (which runs
    // later in chatPreprocess) then read the resulting `\[2017\]` as a `\[...\]` LaTeX display
    // block, splitting the link and typesetting "2017" as an equation.
    const dirty = `see ${cite('Vault: Attention [2017] notes')} for details`;
    const out = chatPreprocess(dirty);
    expect(out).not.toContain('$$');
    expect(out.match(/\]\(#\/cite\//g)).toHaveLength(1);
    expect(out).toContain('#/cite/Attention%20%5B2017%5D%20notes');
  });

  it('keeps a valid link when the title ends with a backslash', () => {
    // Regression: a raw trailing backslash in link text used to escape the closing `]`,
    // breaking the markdown link.
    const dirty = cite('Vault: Trailing Slash\\');
    const out = chatPreprocess(dirty);
    expect(out).toMatch(/^\[Trailing Slash&#92;\]\(#\/cite\/Trailing%20Slash%5C\)$/);
  });

  it('keeps the paragraph break when a web ref at a paragraph start is dropped', () => {
    const dirty = `para one\n\n${cite('turn0search0')} para two`;
    expect(chatPreprocess(dirty)).toContain('para one\n\n');
  });
});
