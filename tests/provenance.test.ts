import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSources, recordSource, reconcileAttribution, sourceFor, type SourceRecord,
} from '../src/server/provenance.js';

const rec = (over: Partial<SourceRecord> = {}): SourceRecord => ({
  book: 'The essence of calculus',
  title: 'The essence of calculus',
  authors: ['3Blue1Brown'],
  attribution: 'verified',
  origin: { kind: 'video', url: 'https://youtu.be/x', platform: 'YouTube' },
  addedAt: '2026-07-30T00:00:00.000Z',
  ...over,
});

describe('reconcileAttribution — the platform outranks the model', () => {
  it('a claim that contradicts the source loses, and the disagreement is named in full', () => {
    // The incident, exactly: a model credits a video to 3blue1brown; YouTube says otherwise.
    const out = reconcileAttribution(['3Blue1Brown'], ['Branch Education']);
    expect(out.authors).toEqual(['Branch Education']);
    expect(out.attribution).toBe('verified');
    expect(out.attributionWarning).toBe(
      'attributed to 3Blue1Brown, but the source itself credits Branch Education',
    );
  });

  it('a reported byline with no claim to check is verified and unremarkable', () => {
    const out = reconcileAttribution(undefined, ['Grant Sanderson']);
    expect(out).toEqual({ authors: ['Grant Sanderson'], attribution: 'verified' });
  });

  it('naming one of several co-authors is agreement, not misattribution', () => {
    // The set INTERSECTS — the model was right, just incomplete. Warning here would fire on the
    // common case and train the learner to ignore it.
    const out = reconcileAttribution(
      ['Vaswani'],
      ['Vaswani', 'Shazeer', 'Parmar'],
    );
    expect(out.authors).toEqual(['Vaswani', 'Shazeer', 'Parmar']);
    expect(out.attribution).toBe('verified');
    expect(out.attributionWarning).toBeUndefined();
  });

  it('agreement survives case and whitespace differences', () => {
    const out = reconcileAttribution(['  3blue1brown '], ['3Blue1Brown']);
    expect(out).toEqual({ authors: ['3Blue1Brown'], attribution: 'verified' });
  });

  it('a claim with nothing to check it against is claimed — unverified, not wrong', () => {
    const out = reconcileAttribution(['Andrej Karpathy'], undefined);
    expect(out).toEqual({ authors: ['Andrej Karpathy'], attribution: 'claimed' });
  });

  it('empty-string and whitespace-only names do not count as an attribution', () => {
    expect(reconcileAttribution(['  ', ''], [])).toEqual({ authors: [], attribution: 'unknown' });
  });

  it('neither side speaks: unknown, with no invented byline', () => {
    expect(reconcileAttribution(undefined, undefined)).toEqual({ authors: [], attribution: 'unknown' });
  });
});

describe('the sources sidecar', () => {
  const freshVault = () => mkdtempSync(join(tmpdir(), 'lwh-prov-'));

  it('round-trips a record and finds it by book', () => {
    const vault = freshVault();
    recordSource(vault, rec());
    expect(readSources(vault)).toEqual([rec()]);
    expect(sourceFor(vault, 'The essence of calculus')?.authors).toEqual(['3Blue1Brown']);
    expect(sourceFor(vault, 'Some Other Book')).toBeUndefined();
  });

  it('a corrupt file reads as empty instead of throwing', () => {
    // readSources runs inside a compile and on every Library poll; a torn write must cost bylines,
    // not 500 both.
    const vault = freshVault();
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'sources.json'), '[{"book": "half-writ');
    expect(readSources(vault)).toEqual([]);
    expect(sourceFor(vault, 'anything')).toBeUndefined();
  });

  it('JSON that parses but is not an array also reads as empty', () => {
    const vault = freshVault();
    mkdirSync(join(vault, '.harness'), { recursive: true });
    writeFileSync(join(vault, '.harness', 'sources.json'), '{"book":"not an array"}');
    expect(readSources(vault)).toEqual([]);
  });

  it('an empty vault path is a silent no-op, never a throw', () => {
    expect(() => recordSource('', rec())).not.toThrow();
    expect(readSources('')).toEqual([]);
    expect(sourceFor('', 'anything')).toBeUndefined();
  });

  it('re-ingesting a source REPLACES its record rather than stacking a duplicate', () => {
    // Same identity rule as enqueueChapters: a duplicate `book` row means every later lookup
    // resolves to the stale first match and the corrected attribution is never the one shown.
    const vault = freshVault();
    recordSource(vault, rec({ authors: ['Wrongly Credited'], attribution: 'claimed' }));
    recordSource(vault, rec());
    const all = readSources(vault);
    expect(all).toHaveLength(1);
    expect(all[0].attribution).toBe('verified');
    expect(sourceFor(vault, 'The essence of calculus')?.authors).toEqual(['3Blue1Brown']);
  });

  it('keeps unrelated books alongside an upsert', () => {
    const vault = freshVault();
    recordSource(vault, rec({ book: 'A' }));
    recordSource(vault, rec({ book: 'B' }));
    recordSource(vault, rec({ book: 'A', title: 'A again' }));
    expect(readSources(vault).map((r) => r.book).sort()).toEqual(['A', 'B']);
    expect(sourceFor(vault, 'A')?.title).toBe('A again');
  });

  it('a mismatch lands in the vault guardrail log, not only in the record', () => {
    // Same log as session.ts's unrecorded-evidence findings: a model's byline being wrong is an
    // integrity finding, and integrity findings live in one place.
    const vault = freshVault();
    recordSource(vault, rec({
      attributionWarning: 'attributed to 3Blue1Brown, but the source itself credits Branch Education',
    }));
    const log = readFileSync(join(vault, '.harness', 'guardrail.log'), 'utf8');
    expect(log).toContain('attribution mismatch for "The essence of calculus"');
    expect(log).toContain('but the source itself credits Branch Education');
  });
});
