import { PATTERN_CATALOG } from '@forge/contracts/pattern-catalog';
import { describe, expect, it } from 'vitest';
import { THIS_REPOSITORY } from '../lib/this-repository.js';
import {
  type CatalogReading,
  catalogReadingOf,
  decideRefusals,
  nameOutcome,
  type PatternDecider,
  type PatternRowFacts,
  releaseFaults,
  retractRefusals,
  unansweredReturns,
} from './pattern-rules.js';

const catalog = catalogReadingOf(THIS_REPOSITORY);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute));
const row = (over: Partial<PatternRowFacts> = {}): PatternRowFacts => ({
  id: 'p1',
  pattern: 'webhook-door',
  kind: 'new',
  namedBy: 'author',
  namedSession: null,
  createdAt: at(0),
  decision: null,
  decidedAt: null,
  retractedAt: null,
  ...over,
});
/** A person deciding, by account. */
const person = (userId: string): PatternDecider => ({
  userId,
  box: null,
  session: null,
  namerLiveHere: false,
});
/** A run on box `box`, every run there acting as account `box-account`. */
const runOn = (session: string | null, namerLiveHere = false): PatternDecider => ({
  userId: 'box-account',
  box: 'box',
  session,
  namerLiveHere,
});
const decided = (over: Partial<PatternRowFacts>) =>
  row({ decision: 'returned', decidedAt: at(5), ...over });
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
    expect(decideRefusals('ISS-9', row(), person('reviewer'))).toEqual([]);
  });

  it('refuses its author, a reuse, a decided one and a retracted one, each by name', () => {
    const codes = (r: PatternRowFacts, d = person('x')) =>
      decideRefusals('ISS-9', r, d).map((f) => f.code);
    expect(codes(row(), person('author'))).toEqual(['PATTERN_REVIEWER_IS_AUTHOR']);
    expect(codes(row({ kind: 'reuse' }))).toEqual(['PATTERN_NOT_NEW']);
    expect(codes(row({ decision: 'approved' }))).toEqual(['PATTERN_ALREADY_DECIDED']);
    expect(codes(row({ retractedAt: new Date() }))).toEqual(['PATTERN_RETRACTED']);
  });
});

describe('the author of a pattern a run named is that run, not the account it shares', () => {
  const ofRunA = row({ namedBy: 'box-account', namedSession: 'run-a' });

  it('refuses the run that named it', () => {
    expect(decideRefusals('ISS-9', ofRunA, runOn('run-a')).map((r) => r.code)).toEqual([
      'PATTERN_REVIEWER_IS_AUTHOR',
    ]);
  });

  it('lets another run on the same box account decide it, and a person, even the box holder', () => {
    expect(decideRefusals('ISS-9', ofRunA, runOn('run-b'))).toEqual([]);
    expect(decideRefusals('ISS-9', ofRunA, person('box-account'))).toEqual([]);
  });

  it('refuses a box call that names no run while the naming run is live on that box', () => {
    expect(decideRefusals('ISS-9', ofRunA, runOn(null, true)).map((r) => r.code)).toEqual([
      'PATTERN_REVIEWER_RUN_UNNAMED',
    ]);
    expect(decideRefusals('ISS-9', ofRunA, runOn(null, false))).toEqual([]);
  });

  it("keeps the person rule for a person's pattern: that account is refused, from a box too", () => {
    const ofPerson = row({ namedBy: 'alice' });
    expect(decideRefusals('ISS-9', ofPerson, person('alice')).map((r) => r.code)).toEqual([
      'PATTERN_REVIEWER_IS_AUTHOR',
    ]);
    const aliceBox = { ...runOn('run-a'), userId: 'alice' };
    expect(decideRefusals('ISS-9', ofPerson, aliceBox).map((r) => r.code)).toEqual([
      'PATTERN_REVIEWER_IS_AUTHOR',
    ]);
    expect(decideRefusals('ISS-9', ofPerson, runOn('run-a'))).toEqual([]);
  });
});

describe('retracting a pattern', () => {
  it('retracts a row once, and never a returned one, which stays as the record of the return', () => {
    expect(retractRefusals('ISS-9', row())).toEqual([]);
    expect(retractRefusals('ISS-9', row({ retractedAt: new Date() })).map((r) => r.code)).toEqual([
      'PATTERN_RETRACTED',
    ]);
    expect(retractRefusals('ISS-9', decided({})).map((r) => r.code)).toEqual(['PATTERN_RETURNED']);
  });
});

describe('a returned pattern holds until the issue answers it', () => {
  it('is unanswered while no live row was named after the return', () => {
    expect(unansweredReturns([decided({})]).map((r) => r.id)).toEqual(['p1']);
    const before = row({ id: 'p0', pattern: 'api-route', kind: 'reuse', createdAt: at(1) });
    expect(unansweredReturns([before, decided({})]).map((r) => r.id)).toEqual(['p1']);
  });

  it('is answered by another pattern, or by the slug named again, named after the return', () => {
    const other = row({ id: 'p2', pattern: 'api-route', kind: 'reuse', createdAt: at(6) });
    const revised = row({ id: 'p3', createdAt: at(7) });
    expect(unansweredReturns([decided({}), other])).toEqual([]);
    expect(unansweredReturns([decided({}), revised])).toEqual([]);
  });

  it('is unanswered again when the row that answered it is retracted', () => {
    const answer = row({ id: 'p2', pattern: 'api-route', kind: 'reuse', createdAt: at(6) });
    const withdrawn = { ...answer, retractedAt: at(8) };
    expect(unansweredReturns([decided({}), withdrawn]).map((r) => r.id)).toEqual(['p1']);
  });
});

describe('what the move to awaiting_release asks of the patterns', () => {
  it('asks nothing of a reuse, an answered return, a retracted one, or an approved one', () => {
    const rows = [
      row({ id: 'p0', kind: 'reuse', pattern: 'api-route', createdAt: at(9) }),
      decided({}),
      row({ id: 'p2', pattern: 'other', retractedAt: new Date() }),
      row({ id: 'p3', pattern: 'queue-door', decision: 'approved', decidedAt: at(2) }),
    ];
    expect(releaseFaults('ISS-9', rows)).toEqual([]);
  });

  it('refuses a pending review and an unanswered return, each by name', () => {
    const faults = releaseFaults('ISS-9', [row(), decided({ id: 'p2', pattern: 'queue-door' })]);
    expect(faults.map((f) => f.code)).toEqual(['PATTERN_REVIEW_PENDING', 'PATTERN_RETURNED']);
    expect(faults[1]?.detail).toContain('`queue-door`');
  });

  it('never reads the catalog: an approved new pattern the running build lacks passes the move', () => {
    const approved = row({ pattern: 'not-yet-released', decision: 'approved', decidedAt: at(2) });
    expect(releaseFaults('ISS-9', [approved])).toEqual([]);
  });
});
