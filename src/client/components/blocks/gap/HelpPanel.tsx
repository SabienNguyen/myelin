// Track A (docs/superpowers/plans/2026-07-21-coding-stage.md "A. In-IDE tutor help"): the
// focus-mode brief panel's Help tab — a small composer plus a scrollable transcript of this
// exercise's help exchanges. The transcript itself is owned by the caller (CodeExercise.tsx),
// same lifted-state reason PlanPanel's `planText` is caller-owned (see that file's top comment):
// FocusLayout only ever renders the CURRENTLY ACTIVE tab's content, so a component with its own
// local transcript state would lose it every time the learner switches to another tab and back.
// Only the composer's in-flight draft and pending/error UI state are local here — losing an
// unsent question on tab-switch is an acceptable, minor trade rather than one more thing to lift.

import { useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { chatPreprocess } from '../../../lib/panelBus.js';
import { HELP_COMPOSER_INPUT_ID } from './FocusLayout.js';
import { postHelp } from './api.js';
import type { TemplateKind } from './types.js';

export interface HelpExchange {
  question: string;
  hint: string;
}

export interface HelpPanelProps {
  pattern: string;
  rung: TemplateKind;
  /** The learner's current gap contents (full_body only — worked_example/inline_completion have
   *  no caller-visible draft to thread; see CodeExercise.tsx's `code` state). */
  draft: string;
  /** Failing test names from the learner's last run (empty when there hasn't been one). */
  failures: string[];
  exchanges: HelpExchange[];
  onExchangeAdded: (exchange: HelpExchange) => void;
}

export function HelpPanel({ pattern, rung, draft, failures, exchanges, onExchangeAdded }: HelpPanelProps) {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function ask(): Promise<void> {
    const trimmed = question.trim();
    if (trimmed === '' || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const { hint } = await postHelp({ pattern, rung, question: trimmed, draft, failures });
      onExchangeAdded({ question: trimmed, hint });
      setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reach the tutor.');
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void ask();
    }
  }

  return (
    <div className="help-panel">
      <ul className="help-transcript" aria-label="help exchanges for this exercise">
        {exchanges.length === 0 && !pending && (
          <li className="help-transcript-empty">no questions asked yet for this exercise.</li>
        )}
        {exchanges.map((exchange, i) => (
          <li key={i} className="help-exchange">
            <p className="help-exchange-question">{exchange.question}</p>
            <div className="help-exchange-hint">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {chatPreprocess(exchange.hint)}
              </ReactMarkdown>
            </div>
          </li>
        ))}
        {pending && (
          <li className="help-exchange-pending" role="status">
            thinking…
          </li>
        )}
      </ul>

      {error && (
        <p className="help-panel-error" role="alert">
          {error}
        </p>
      )}

      <div className="help-composer">
        <label className="help-composer-label" htmlFor={HELP_COMPOSER_INPUT_ID}>
          ask about this exercise…
        </label>
        <textarea
          id={HELP_COMPOSER_INPUT_ID}
          className="help-composer-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="ask about this exercise…"
          disabled={pending}
        />
        <button
          type="button"
          className="help-composer-send"
          onClick={() => void ask()}
          disabled={pending || question.trim() === ''}
        >
          {pending ? 'asking…' : 'ask'}
        </button>
      </div>
    </div>
  );
}
