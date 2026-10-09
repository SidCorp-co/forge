import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import { describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../lib/this-repository.js';
import {
  type CatalogReading,
  catalogReadingOf,
  decideRefusals,
  nameOutcome,
  type PatternRowFacts,
  releaseFaults,
  retractRefusals,
} from './pattern-rules.js';

const catalog = catalogReadingOf(THIS_REPOSITORY);
const row = (over: Partial<PatternRowFacts> = {}): PatternRowFacts => ({
  id: 'p1',
  pattern: 'webhook-door',
  kind: 'new',
  namedBy: 'author',
  decision: null,
  retractedAt: null,
  ...over,
});
const name = (over: Partial<Parameters<typeof nameOutcome>[0]> = {}) =>
  nameOutcome({
    issueRef: 'ISS-9',
    terminal: false,
    catalog,
    pattern: 'api-route',
    summary: null,
    live: [],
    ...over,
  });
const codes = (out: { ok: boolean; refusals?: { code: string }[] }) =>
  (out.refusals ?? []).map((r) => r.code);

describe('the catalog a project reads', () => {
  it('is the catalog of this build, every slug in it, for a project declaring this repository', () => {
    expect(catalog.kind).toBe('read');
    const slugs = catalog.kind === 'read' ? [...catalog.slugs].sort() : [];
    expect(slugs).toEqual(PATTERN_CATALOG.map((e) => e.slug).sort());
    expect(slugs).toContain('api-route');
  });

  it('is undeclared for any other repository, and for none, naming why', () => {
    for (const repo of ['github.com/acme/shop', null]) {
      const reading = catalogReadingOf(repo);
      expect(reading.kind).toBe('undeclared');
      expect(reading.kind === 'undeclared' && reading.detail).toContain(THIS_REPOSITORY);
    }
  });
});

describe('naming a pattern on an issue', () => {
  it('records a catalogued slug as reuse, which needs no summary and no approval', () => {
    expect(name()).toEqual({ ok: true, kind: 'reuse' });
  });

  it('records an uncatalogued slug as new, and refuses one sent without its summary', () => {
    expect(codes(name({ pattern: 'webhook-door' }))).toEqual(['PATTERN_SUMMARY_REQUIRED']);
    expect(name({ pattern: 'webhook-door', summary: 'a door for inbound webhooks' })).toEqual({
      ok: true,
      kind: 'new',
    });
  });

  it('refuses a project whose catalog Forge cannot read, a finished issue, and a slug named twice', () => {
    const undeclared: CatalogReading = { kind: 'undeclared', detail: 'no catalog' };
    expect(codes(name({ catalog: undeclared }))).toEqual(['PATTERN_CATALOG_UNDECLARED']);
    expect(codes(name({ terminal: true }))).toEqual(['PATTERN_ISSUE_FINISHED']);
    expect(codes(name({ live: [row({ pattern: 'api-route', kind: 'reuse' })] }))).toEqual([
      'PATTERN_ALREADY_NAMED',
    ]);
  });

  it('names a slug again once its row was returned or retracted', () => {
    const returned = row({ decision: 'returned' });
    const retracted = row({ retractedAt: new Date() });
    for (const live of [[returned], [retracted]]) {
      expect(name({ pattern: 'webhook-door', summary: 'revised', live }).ok).toBe(true);
    }
  });
});

describe('deciding a new pattern', () => {
  it('lets a reviewer other than its author decide an undecided new pattern', () => {
    expect(decideRefusals('ISS-9', row(), 'reviewer')).toEqual([]);
  });

  it('refuses its author, a reuse, a decided one and a retracted one, each by name', () => {
    expect(decideRefusals('ISS-9', row(), 'author').map((r) => r.code)).toEqual([
      'PATTERN_REVIEWER_IS_AUTHOR',
    ]);
    expect(decideRefusals('ISS-9', row({ kind: 'reuse' }), 'x').map((r) => r.code)).toEqual([
      'PATTERN_NOT_NEW',
    ]);
    expect(decideRefusals('ISS-9', row({ decision: 'approved' }), 'x').map((r) => r.code)).toEqual([
      'PATTERN_ALREADY_DECIDED',
    ]);
    expect(
      decideRefusals('ISS-9', row({ retractedAt: new Date() }), 'x').map((r) => r.code),
    ).toEqual(['PATTERN_RETRACTED']);
  });

  it('retracts a row once', () => {
    expect(retractRefusals('ISS-9', row())).toEqual([]);
    expect(retractRefusals('ISS-9', row({ retractedAt: new Date() })).map((r) => r.code)).toEqual([
      'PATTERN_RETRACTED',
    ]);
  });
});

describe('what the move to awaiting_release asks of the patterns', () => {
  it('asks nothing of a reuse, a returned pattern or a retracted one', () => {
    const rows = [
      row({ kind: 'reuse', pattern: 'api-route' }),
      row({ decision: 'returned' }),
      row({ id: 'p2', pattern: 'other', retractedAt: new Date() }),
    ];
    expect(releaseFaults('ISS-9', rows, catalog)).toEqual([]);
  });

  it('refuses a pending review, and an approved new pattern whose entry the catalog lacks', () => {
    const faults = releaseFaults(
      'ISS-9',
      [row(), row({ id: 'p2', pattern: 'queue-door', decision: 'approved' })],
      catalog,
    );
    expect(faults.map((f) => f.code)).toEqual(['PATTERN_REVIEW_PENDING', 'PATTERN_ENTRY_MISSING']);
    expect(faults[1]?.detail).toContain('docs/patterns/queue-door.md');
  });

  it('passes an approved new pattern once the catalog the project reads holds its entry', () => {
    const landed: CatalogReading = { kind: 'read', slugs: new Set(['queue-door']) };
    const approved = row({ pattern: 'queue-door', decision: 'approved' });
    expect(releaseFaults('ISS-9', [approved], landed)).toEqual([]);
  });
});
