// The small pure pieces behind the setup and status UI. Each one exists because a screenshot showed
// the raw value being wrong to read, so these pin the readable form rather than the plumbing.

import { describe, it, expect } from 'vitest';
import { displayPath } from '../src/server/setupRoutes.js';
import { modelLabel } from '../src/client/components/TopbarStatus.js';

describe('displayPath', () => {
  it('shortens a path under home to the form a person would say', () => {
    // Screenshotting the first-run card showed four lines of absolute path as the first thing the
    // eye landed on, for the least useful information on the screen.
    expect(displayPath('/home/sabien/Documents/Myelin', '/home/sabien'))
      .toBe('~/Documents/Myelin');
  });

  it('leaves a path outside home alone', () => {
    expect(displayPath('/srv/vaults/shared', '/home/sabien')).toBe('/srv/vaults/shared');
  });

  it('does not mangle a home-prefixed sibling directory', () => {
    // '/home/sabienne' starts with '/home/sabien' as a string but is a different directory. The
    // tilde form would be actively misleading, so it is left absolute.
    expect(displayPath('/home/sabienne/vault', '/home/sabien')).toBe('/home/sabienne/vault');
  });
});

describe('modelLabel', () => {
  it('says which model and whose bill, not the raw id', () => {
    // The topbar badge read the raw model id — an implementation detail of how the harness routes
    // a request, sitting next to the learner's own name.
    expect(modelLabel('claude-sonnet-5')).toEqual({ name: 'Sonnet 5', how: 'Anthropic API' });
    expect(modelLabel('claude-haiku-4-5')).toEqual({ name: 'Haiku 4.5', how: 'Anthropic API' });
  });

  // The badge said "via Anthropic API" over an openai: id, and ran it through the claude-* pretty
  // printer — a live badge read "Openai:gpt-5.6-luna", an id that exists nowhere, billed to the
  // wrong vendor. Naming the wrong vendor is the one thing this badge must never do.
  it('names the OpenAI-compatible route, and shows its id verbatim', () => {
    expect(modelLabel('openai:gpt-5.6-luna'))
      .toEqual({ name: 'gpt-5.6-luna', how: 'OpenAI-compatible endpoint' });
    expect(modelLabel('openai:deepseek/deepseek-chat'))
      .toEqual({ name: 'deepseek/deepseek-chat', how: 'OpenAI-compatible endpoint' });
  });

  it('leaves a local model name as its author wrote it', () => {
    // An Ollama tag is chosen by the person running it; prettifying it would only make it wrong.
    expect(modelLabel('ollama:qwen2.5-coder:14B'))
      .toEqual({ name: 'qwen2.5-coder:14B', how: 'local model via Ollama' });
  });
});
