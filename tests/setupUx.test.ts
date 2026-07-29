// The small pure pieces behind the setup and status UI. Each one exists because a screenshot showed
// the raw value being wrong to read, so these pin the readable form rather than the plumbing.

import { describe, it, expect } from 'vitest';
import { displayPath } from '../src/server/setupRoutes.js';
import { modelLabel } from '../src/client/components/TopbarStatus.js';
import { applyRoute, resetRouteModels } from '../src/server/signin.js';

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
  it('says which model and whose bill, not the routing prefix', () => {
    // The topbar badge read `claude-sdk:sonnet` — an implementation detail of how the harness routes
    // a request, sitting next to the learner's own name.
    expect(modelLabel('claude-sdk:sonnet')).toEqual({ name: 'Sonnet', how: 'Claude subscription' });
    expect(modelLabel('claude-sonnet-5')).toEqual({ name: 'Sonnet 5', how: 'Anthropic API' });
    expect(modelLabel('claude-haiku-4-5')).toEqual({ name: 'Haiku 4.5', how: 'Anthropic API' });
  });

  it('leaves a local model name as its author wrote it', () => {
    // An Ollama tag is chosen by the person running it; prettifying it would only make it wrong.
    expect(modelLabel('ollama:qwen2.5-coder:14B'))
      .toEqual({ name: 'qwen2.5-coder:14B', how: 'local model via Ollama' });
  });
});

describe('applyRoute', () => {
  const cfg = () => ({
    models: {
      tutor: { model: 'claude-sonnet-5' },
      grader: { model: 'claude-haiku-4-5' },
      quiz_gen: { model: 'claude-sonnet-5' },
      card_gen: { model: 'claude-haiku-4-5' },
      compile: { model: 'claude-sonnet-5' },
    },
  });

  it('switches every defaulted role onto the subscription', () => {
    const c = cfg();
    applyRoute(c, new Set(), 'subscription');
    expect(Object.values(c.models).every((r) => r.model.startsWith('claude-sdk:'))).toBe(true);
    expect(c.models.tutor.model).toBe('claude-sdk:sonnet');
  });

  it('keeps an explicitly chosen Anthropic model but reroutes it through the login', () => {
    // The user picked a MODEL, then clicked "use my subscription" — honour both. Leaving the
    // explicit id on the API route meant the signin click succeeded and left the app exactly as
    // blocked as before, with no error and no visible change (the stranded-FirstRun bug).
    const c = cfg();
    applyRoute(c, new Set(['grader']), 'subscription');
    expect(c.models.grader.model).toBe('claude-sdk:claude-haiku-4-5');
    expect(c.models.tutor.model).toBe('claude-sdk:sonnet');
  });

  it('never touches an explicit role that already names its own route', () => {
    // `ollama:qwen` is a statement about where the model runs; `claude-sdk:opus` already rides
    // the login. A billing choice must not rewrite either.
    const c = cfg();
    c.models.grader.model = 'ollama:qwen';
    c.models.compile.model = 'claude-sdk:opus';
    applyRoute(c, new Set(['grader', 'compile']), 'subscription');
    expect(c.models.grader.model).toBe('ollama:qwen');
    expect(c.models.compile.model).toBe('claude-sdk:opus');
  });

  it('is idempotent: a second application changes nothing', () => {
    const c = cfg();
    applyRoute(c, new Set(['tutor']), 'subscription');
    const after = JSON.stringify(c);
    applyRoute(c, new Set(['tutor']), 'subscription');
    expect(JSON.stringify(c)).toBe(after);
  });

  it('does nothing for the api-key route or no route at all', () => {
    for (const route of ['api-key', null] as const) {
      const c = cfg();
      applyRoute(c, new Set(), route);
      expect(c.models.tutor.model).toBe('claude-sonnet-5');
    }
  });
});

describe('resetRouteModels — switching back off the subscription route', () => {
  const cfg = () => ({
    models: {
      tutor: { model: 'claude-sonnet-5' },
      grader: { model: 'claude-haiku-4-5' },
      quiz_gen: { model: 'claude-sonnet-5' },
      card_gen: { model: 'claude-haiku-4-5' },
      compile: { model: 'claude-sonnet-5' },
    },
  });

  it('reverts an in-place subscription rewrite back to the config-file ids', () => {
    // The scenario the api-key route hits: the learner tried the subscription (mutating cfg.models
    // to claude-sdk:* in place), then pasted a key. Without reverting, the tutor keeps routing to
    // claude-sdk: and the pasted key is ignored.
    const c = cfg();
    applyRoute(c, new Set(['grader']), 'subscription');
    expect(c.models.tutor.model).toBe('claude-sdk:sonnet');            // defaulted role rewritten
    expect(c.models.grader.model).toBe('claude-sdk:claude-haiku-4-5'); // explicit id rerouted
    resetRouteModels(c, cfg()); // base = pristine config file
    expect(c.models.tutor.model).toBe('claude-sonnet-5');
    expect(c.models.grader.model).toBe('claude-haiku-4-5');
    expect(Object.values(c.models).some((r) => r.model.startsWith('claude-sdk:'))).toBe(false);
  });

  it('restores an explicit local model to exactly what the config named', () => {
    const c = cfg();
    c.models.grader.model = 'ollama:qwen';
    applyRoute(c, new Set(['grader']), 'subscription'); // ollama:qwen untouched; others -> claude-sdk:
    const base = cfg();
    base.models.grader.model = 'ollama:qwen';
    resetRouteModels(c, base);
    expect(c.models.grader.model).toBe('ollama:qwen');
    expect(c.models.tutor.model).toBe('claude-sonnet-5');
  });
});
