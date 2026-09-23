// The grader's answer key, prepared while the learner is still thinking.
//
// An open answer used to meet the grader only AFTER the reply: one model call on the learner's
// critical path, judging against an `expected` the TUTOR had written in the same breath as the
// question (when it wrote one at all) and that nothing ever checked. Now the question goes to the
// grader the moment it is staged. It decides the answer independently, off the critical path, and
// when the reply arrives the two are compared.
//
// That buys three things. The slow request — a free-tier model can queue for a minute — is spent
// inside the learner's thinking time. A reply that simply IS the prepared answer needs no model
// call at all. And the key is a second opinion on the tutor's `expected`, which is shown to the
// grader as a claim to check rather than as the truth.
//
// Keys live in memory, keyed by the staged block's toolCallId. A restart, a failed key call or a
// reply that beats the key all mean "no key", and grading falls back to what it did before.

import type { HarnessConfig } from './config.js';
import { generateText, type ChatModel } from './llm/index.js';
import { chatModelFor } from './models.js';
import { recordUsage } from './usageLedger.js';

export interface AnswerKey { answer: string; points: string[] }

const MAX_KEYS = 200; // a session stages a handful; this only bounds a server left running for weeks
const keys = new Map<string, Promise<AnswerKey | null>>();
export function resetAnswerKeys(): void { keys.clear(); }

const stripEmphasis = (s: string) => s.replace(/[*_`]+/g, '').trim();

/** Lenient on purpose — small models wrap labels in emphasis and number their bullets — but it
 *  never invents a key: no ANSWER line, no key. */
export function parseAnswerKey(text: string): AnswerKey | null {
  const lines = text.split('\n').map(stripEmphasis);
  const at = lines.findIndex((l) => /^answer\s*:/i.test(l));
  if (at < 0) return null;
  const answer = lines[at].replace(/^answer\s*:/i, '').trim();
  if (!answer) return null;
  const points = lines.slice(at + 1)
    .filter((l) => /^(?:[-•]|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^(?:[-•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return { answer, points };
}

/** Start deciding the answer to a question that was just staged. Fire-and-forget by design: the
 *  caller is in the middle of streaming a turn and must not wait on this. */
export function prepareAnswerKey(
  id: string, question: string, cfg: HarnessConfig, deps: { model?: ChatModel } = {}, tutorExpected?: string,
): void {
  if (keys.has(id) || !question.trim()) return;
  const prompt = 'A tutor is about to ask a student this question. Decide the correct answer NOW, before the '
    + `student replies, so their reply can be compared against it.\n\nQuestion: ${question}\n`
    + (tutorExpected
      ? `The tutor believes the answer is: ${tutorExpected}\nCheck that — it may be wrong or incomplete. Do not trust it; answer the question yourself.\n`
      : '')
    + '\nReply in exactly this form:\nANSWER: <the correct answer, in one line>\nPOINTS:\n'
    + '- <something a fully correct answer must contain>\n(one to four points, each a short phrase)';
  const pending = (async (): Promise<AnswerKey | null> => {
    try {
      const { text, usage } = await generateText({ model: deps.model ?? chatModelFor('grader', cfg), prompt });
      if (cfg.vault) {
        recordUsage(cfg.vault, {
          role: 'grader', model: cfg.models?.grader?.model ?? 'unknown', usage,
          contextTokens: cfg.models?.grader?.contextTokens,
        });
      }
      const key = parseAnswerKey(text);
      if (!key) console.error(`[answer-key] unreadable key for "${question.slice(0, 80)}": ${text.slice(0, 160)}`);
      return key;
    } catch (e) {
      // Not fatal and not silent: the reply will be graded the old way, one call after it arrives.
      console.error(`[answer-key] could not prepare a key for "${question.slice(0, 80)}": ${(e as Error)?.message ?? e}`);
      return null;
    }
  })();
  keys.set(id, pending);
  if (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value!);
}

/** Which staged blocks hold a question only a model can judge, and so are worth a key: a
 *  free-text quick_check, and a quiz's `short` items (filed under `<toolCallId>:<item id>`, the
 *  id grading.ts looks them up by). Choice, cloze and every mechanically-checked block already
 *  carry their own key, and a call spent on them would be a call wasted. */
export function prepareKeysForBlock(
  toolName: string, toolCallId: string, input: unknown, cfg: HarnessConfig, deps: { model?: ChatModel } = {},
): void {
  const block = (input ?? {}) as Record<string, any>;
  if (toolName === 'quick_check' && block.mode === 'text' && typeof block.question === 'string') {
    prepareAnswerKey(toolCallId, block.question, cfg, deps, typeof block.expected === 'string' ? block.expected : undefined);
  }
  if (toolName === 'quiz' && Array.isArray(block.items)) {
    for (const item of block.items) {
      if (item?.type === 'short' && typeof item.prompt === 'string' && typeof item.id === 'string') {
        prepareAnswerKey(`${toolCallId}:${item.id}`, item.prompt, cfg, deps,
          typeof item.expected === 'string' ? item.expected : undefined);
      }
    }
  }
}

/** The prepared key, waiting up to `waitMs` if it is still being decided — the learner answered
 *  faster than the grader. Past that the reply is graded without it rather than held up. */
export async function takeAnswerKey(id: string, waitMs = 20_000): Promise<AnswerKey | null> {
  const pending = keys.get(id);
  if (!pending) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try {
    return await Promise.race([pending, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Is the reply the prepared answer, give or take case, spacing, quotes and a full stop? Only
 *  this exact a match skips the comparison call; anything looser is the grader's to judge. */
export function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
}
