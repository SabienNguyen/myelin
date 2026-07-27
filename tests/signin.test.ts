// signin.ts's storage and detection halves (applyRoute's rewrite rules live in setupUx.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRoute, subscriptionStatus, writeRoute } from '../src/server/signin.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lwh-signin-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readRoute / writeRoute', () => {
  const file = () => join(dir, 'credentials.json');

  it('round-trips both routes through the credentials file', () => {
    mkdirSync(dir, { recursive: true });
    writeRoute('subscription', file());
    expect(readRoute(file())).toBe('subscription');
    writeRoute('api-key', file());
    expect(readRoute(file())).toBe('api-key');
  });

  it('a missing file, junk JSON, or an unknown route all read as null', () => {
    expect(readRoute(join(dir, 'nope.json'))).toBeNull();
    writeFileSync(file(), 'not json at all');
    expect(readRoute(file())).toBeNull();
    writeFileSync(file(), JSON.stringify({ route: 'carrier-pigeon' }));
    expect(readRoute(file())).toBeNull();
  });

  it('writing the route preserves whatever else the file holds (the key lives beside it)', () => {
    writeFileSync(file(), JSON.stringify({ anthropicApiKey: 'sk-ant-abc' }));
    writeRoute('subscription', file());
    expect(readRoute(file())).toBe('subscription');
    const stored = JSON.parse(readFileSync(file(), 'utf8'));
    expect(stored.anthropicApiKey).toBe('sk-ant-abc');
  });
});

describe('subscriptionStatus login detection (home-scoped half)', () => {
  // cliFound depends on the machine's PATH and is deliberately not asserted here.

  it('no ~/.claude.json means not logged in', async () => {
    const s = await subscriptionStatus(dir);
    expect(s.loggedIn).toBe(false);
    expect(s.email).toBeUndefined();
  });

  it('a login with an account uuid reads as logged in, with the email surfaced', async () => {
    writeFileSync(join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'u-1', emailAddress: 'sab@example.com' } }));
    const s = await subscriptionStatus(dir);
    expect(s.loggedIn).toBe(true);
    expect(s.email).toBe('sab@example.com');
  });

  it('a stale or malformed state file degrades to not-logged-in, never a throw', async () => {
    writeFileSync(join(dir, '.claude.json'), '{broken');
    expect((await subscriptionStatus(dir)).loggedIn).toBe(false);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    expect((await subscriptionStatus(dir)).loggedIn).toBe(false);
  });
});
