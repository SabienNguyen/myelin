import { Fragment, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// $…$ or \(…\). A lone $ ("costs $5") has no partner on its line and stays literal.
const MATH = /\$([^$\n]+?)\$|\\\((.+?)\\\)/g;

/** A choice or an answer key: the exact string a grader compares, so it renders literally except
 *  for delimited maths. Through full markdown, an expected `__init__` showed as bold "init" and
 *  `x*y*z` put an italic y beside the learner's xyz, which read as the same text marked wrong; a
 *  "- 5" choice became a bullet and a link choice navigated the tab. */
export function AnswerText({ text }: { text: string }) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(MATH)) {
    if (m.index > last) out.push(<Fragment key={`t${last}`}>{s.slice(last, m.index)}</Fragment>);
    const html = katex.renderToString(m[1] ?? m[2], { throwOnError: false, trust: false });
    out.push(<span key={`m${m.index}`} dangerouslySetInnerHTML={{ __html: html }} />);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(<Fragment key={`t${last}`}>{s.slice(last)}</Fragment>);
  return <>{out}</>;
}
