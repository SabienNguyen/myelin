// Inline asides (spec's Approved design): a SEPARATE small model call on the tutor model,
// answering one question about a message the tutor already sent — never a chat turn, never a
// write. Tools are read-only: search + read_page (Engram) and web research where the route has
// it. No block tools, no record_evidence, no write_page — grounding, not teaching.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AsideData, AsidePart, AsideRequest } from '../shared/aside.js';
import { ASIDE_MAX_QUESTION } from '../shared/aside.js';
import type { HarnessConfig } from './config.js';
import { runLoop, type ChatModel, type LoopTool } from './llm/index.js';
import { enqueueLessonNotes, sourcesFromToolPart } from './lessonNotes.js';
import type { Engram } from './mcp.js';
import { chatModelFor } from './models.js';
import { addPartToMessage, assertThreadId, loadThread } from './sessionStore.js';
import { threadTopic } from './session.js';
import { buildWebTools } from './webTools.js';

export interface AsideDeps {
  model?: ChatModel;
  now?: () => Date;
}

const ASIDE_SYSTEM_PROMPT = 'You are answering ONE side question from a student mid-lesson, not '
  + 'continuing the lesson itself. The student is reading an explanation from their tutor and '
  + 'asked about a concept in it (or a phrase they highlighted) without wanting to derail what '
  + 'the tutor is doing. Explain JUST that concept, briefly — 120 to 250 words, plain markdown, '
  + 'no headings. Ground your answer in the vault pages or web sources you can find with your '
  + 'tools; if you cite a web source, name it inline by title, and if you read a vault page, say '
  + 'which one. If you cannot find anything to ground the answer in and are answering from your '
  + 'own memory, say so plainly, ending your answer with the line "(from memory — not checked '
  + 'against a source)" on its own. Never answer the lesson\'s own pending question — that is not '
  + 'yours to resolve here.';

function bodyText(text: string | undefined): string {
  return (text ?? '').trim();
}

/** `POST /api/aside`. `lw` may be null (a degraded boot with no vault connected) — every request
 * then 502s rather than 500ing on a null dereference, same "degrade loudly" rule as the rest of
 * the harness. */
export function buildAsideRoute(lw: Engram | null, cfg: HarnessConfig, deps: AsideDeps = {}): Hono {
  const app = new Hono();

  app.post('/api/aside', async (c) => {
    let body: Partial<AsideRequest>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const threadId = body.threadId;
    if (typeof threadId !== 'string') return c.json({ error: 'threadId is required' }, 400);
    try {
      assertThreadId(threadId);
    } catch (e: any) {
      return c.json({ error: e?.message ?? 'invalid threadId' }, 400);
    }

    const messageId = body.messageId;
    if (typeof messageId !== 'string' || !messageId) {
      return c.json({ error: 'messageId is required' }, 400);
    }

    const question = bodyText(body.question);
    if (!question) return c.json({ error: 'question is required' }, 400);
    if (question.length > ASIDE_MAX_QUESTION) {
      return c.json({ error: `question must be at most ${ASIDE_MAX_QUESTION} characters` }, 400);
    }

    const quote = body.quote;
    if (quote !== undefined && (typeof quote !== 'string' || quote.length > ASIDE_MAX_QUESTION)) {
      return c.json({ error: `quote must be a string of at most ${ASIDE_MAX_QUESTION} characters` }, 400);
    }

    if (!lw) return c.json({ error: 'the vault is not connected' }, 502);

    const messages = loadThread(cfg.vault, threadId) as any[];
    const anchor = messages.find((m) => m?.id === messageId && m?.role === 'assistant');
    if (!anchor) {
      return c.json({ error: `no assistant message "${messageId}" in thread "${threadId}"` }, 404);
    }

    const anchorText = ((anchor.parts ?? []) as any[])
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n\n')
      .trim();

    const model = deps.model ?? chatModelFor('tutor', cfg);
    const mcpTools = (await lw.tools()).filter((t) => t.name === 'search' || t.name === 'read_page');
    const web = buildWebTools(cfg, cfg.models?.tutor?.model);
    const tools: LoopTool[] = [...mcpTools, ...web.tools];

    const userText = [
      'The student is reading this explanation from their tutor:',
      '"""',
      anchorText || '(the message had no text)',
      '"""',
      quote ? `They highlighted this part of it: "${quote}"` : null,
      `Their aside question: ${question}`,
    ].filter((line): line is string => line !== null).join('\n');

    const vaultPages = new Set<string>();
    const sources: { url: string; title?: string }[] = [];
    const seenUrls = new Set<string>();
    const addSources = (found: { url: string; title?: string }[]) => {
      for (const s of found) {
        if (seenUrls.has(s.url)) continue;
        seenUrls.add(s.url);
        sources.push(s);
      }
    };
    // toolCallId -> the call that produced it, so a 'tool-result' event (which carries no input
    // of its own) can be matched back to the call that made it — sourcesFromToolPart needs both.
    const callsById = new Map<string, { name: string; input: unknown }>();

    let answer: string;
    try {
      const result = await runLoop({
        model,
        system: ASIDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        tools,
        serverTools: web.serverTools,
        maxSteps: 6,
        onEvent: (e: any) => {
          if (e.type === 'tool-call') {
            callsById.set(e.toolCallId, { name: e.toolName, input: e.input });
            if (e.toolName === 'read_page' && typeof e.input?.slug === 'string') {
              vaultPages.add(e.input.slug);
            }
          } else if (e.type === 'server-tool-result') {
            addSources(sourcesFromToolPart(e.toolName, true, undefined, e.output));
          } else if (e.type === 'tool-result') {
            const call = callsById.get(e.toolCallId);
            if (call) addSources(sourcesFromToolPart(call.name, false, call.input, e.output));
          }
        },
      });
      answer = result.steps.map((s) => s.text).filter(Boolean).join('\n\n').trim();
      if (!answer) throw new Error('the tutor model returned no answer for this aside');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      console.error('[aside]', message);
      return c.json({ error: message }, 502);
    }

    const fromMemory = sources.length === 0 && vaultPages.size === 0;
    const createdAt = (deps.now?.() ?? new Date()).toISOString();
    const data: AsideData = {
      asideId: randomUUID(),
      ...(quote ? { quote } : {}),
      question,
      answer,
      sources,
      vaultPages: [...vaultPages],
      fromMemory,
      createdAt,
    };
    const part: AsidePart = { type: 'data-aside', id: data.asideId, data };

    addPartToMessage(cfg.vault, threadId, messageId, part);

    // Fire-and-forget, same rule as session.ts's own lesson-notes queueing: a broken compile
    // pipeline must never fail the aside the student is waiting on. isTeachingTurn's length gate
    // is bypassed on purpose — an aside is a deliberate, learner-initiated question about a
    // concept, so it is always worth a lesson note however short the answer turns out to be.
    void enqueueLessonNotes(cfg.vault, {
      threadId,
      topicSlug: threadTopic(messages),
      endedAt: createdAt,
      tutorText: answer,
      exchanges: [{ prompt: question, answer: '' }],
      sources,
    }, { lw, cfg }).catch((e) => console.error('[aside] could not queue lesson notes:', e));

    return c.json({ part });
  });

  return app;
}
