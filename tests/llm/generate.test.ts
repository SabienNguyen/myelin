import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  generateText, generateStructured, zeroUsage,
  type ChatModel, type ChatRequest, type GenerateResult,
} from '../../src/server/llm/index.js';

function fakeModel(result: Partial<GenerateResult>): { model: ChatModel; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    async generate(req) {
      requests.push(req);
      return { text: '', toolCalls: [], usage: zeroUsage(), finishReason: 'stop', ...result };
    },
    async *stream(): AsyncIterable<never> { throw new Error('one-shot helpers never stream'); },
  };
  return { model, requests };
}

describe('generateText', () => {
  it('wraps a single user message and passes system, maxTokens, and cache through', async () => {
    const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 };
    const { model, requests } = fakeModel({ text: 'graded', usage });
    const out = await generateText({ model, system: 'sys', prompt: 'grade this', maxTokens: 200, cache: true });
    expect(out).toEqual({ text: 'graded', usage });
    expect(requests[0]).toEqual({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'grade this' }] }],
      maxTokens: 200,
      cache: true,
    });
  });
});

describe('generateStructured', () => {
  const schema = z.object({ score: z.number(), note: z.string() });

  it('forces one synthetic tool and returns its validated input', async () => {
    const { model, requests } = fakeModel({
      toolCalls: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'grade', input: { score: 4, note: 'solid' } }],
      finishReason: 'tool-calls',
    });
    const out = await generateStructured({ model, prompt: 'grade', schema, schemaName: 'grade' });
    expect(out.object).toEqual({ score: 4, note: 'solid' });
    expect(requests[0].toolChoice).toEqual({ name: 'grade' });
    expect(requests[0].tools).toHaveLength(1);
    const tool = requests[0].tools![0] as { name: string; inputSchema: Record<string, unknown> };
    expect(tool.name).toBe('grade');
    expect(tool.inputSchema).toEqual(z.toJSONSchema(schema));
  });

  it('defaults the synthetic tool name to structured_output', async () => {
    const { model, requests } = fakeModel({
      toolCalls: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'structured_output', input: { score: 1, note: 'n' } }],
    });
    await generateStructured({ model, prompt: 'p', schema });
    expect(requests[0].toolChoice).toEqual({ name: 'structured_output' });
  });

  it('throws loudly when the tool input fails schema validation', async () => {
    const { model } = fakeModel({
      toolCalls: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'grade', input: { score: 'high', note: 'n' } }],
    });
    await expect(generateStructured({ model, prompt: 'p', schema, schemaName: 'grade' }))
      .rejects.toThrow(z.ZodError);
  });

  it('throws when the model returned no tool call at all', async () => {
    const { model } = fakeModel({ text: 'I refuse to use tools' });
    await expect(generateStructured({ model, prompt: 'p', schema, schemaName: 'grade' }))
      .rejects.toThrow(/no grade tool call/);
  });
});
