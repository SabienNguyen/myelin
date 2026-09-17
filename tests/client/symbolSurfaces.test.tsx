// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImeInput } from '../../src/client/components/blocks/ImeInput.js';
import { QuizInner } from '../../src/client/components/blocks/Quiz.js';
import { StructuredCheckInner } from '../../src/client/components/blocks/StructuredCheck.js';
afterEach(cleanup);
it.each(['quick', 'quiz', 'structured'])('submits clicked Unicode through the %s answer surface', (surface) => {
  const submit = vi.fn();
  if (surface === 'quick') render(<ImeInput name="answer" onSubmit={submit} />);
  else if (surface === 'quiz') render(<QuizInner args={{ title: 'Test', items: [{ id: 'a', type: 'text', prompt: 'Symbol?' }] }} addResult={submit} />);
  else render(<StructuredCheckInner args={{ pageSlug: 'test', prompt: 'Symbol?', checker: { kind: 'pattern', expected: 'λ' } }} addResult={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Math symbols' }));
  fireEvent.click(screen.getByRole('button', { name: 'λ — lambda' }));
  fireEvent.click(screen.getByRole('button', { name: surface === 'quick' ? 'Answer' : 'Submit' }));
  expect(submit).toHaveBeenCalledWith(surface === 'quick' ? 'λ'
    : surface === 'quiz' ? { answers: [{ id: 'a', answer: 'λ' }] } : { values: ['λ'] });
});
