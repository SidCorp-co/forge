import type { CriterionDesignView } from '@forge/contracts/issue-design';
import {
  type RecordReviewRequest,
  type ReviewChecklistEntry,
  recordReviewRequestSchema,
} from '@forge/contracts/issue-review';
import { describe, expect, it } from 'vitest';
import type { CatalogReading } from './pattern-rules.js';
import {
  type Builders,
  outcomeOf,
  owedOf,
  reviewCheckViewOf,
  reviewerRefusal,
  reviewRecordFields,
  reviewRefusals,
  storedReviewOf,
  unreviewedDetail,
} from './review-rules.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const ENTRIES = [
  { slug: 'api-route', checklist: ['route holds no rule', 'body is strict'] },
  { slug: 'screen', checklist: ['copy is short'] },
];
const READ: CatalogReading = { kind: 'read', slugs: new Set(['api-route', 'screen']) };
const UNDECLARED: CatalogReading = { kind: 'undeclared', detail: 'this project reads no catalog' };

const line = (
  criterion: number,
  cls: CriterionDesignView['class'],
  pattern: string | null,
): CriterionDesignView => ({
  criterion,
  statement: `criterion ${criterion}`,
  class: cls,
  judge: cls === 'observable' ? 'qa' : 'review',
  pattern,
  proof: 'p',
});

const DESIGN = {
  criteria: [line(1, 'observable', 'api-route'), line(2, 'code_property', 'api-route')],
};

const OWED = owedOf({ design: DESIGN, catalog: READ, entries: ENTRIES });

// five minutes before each call: the default clock a refusal reads is the real one
const whole = (over: Partial<RecordReviewRequest> = {}): RecordReviewRequest => ({
  base: BASE,
  head: HEAD,
  startedAt: new Date(Date.now() - 300_000).toISOString(),
  checklist: [
    { pattern: 'api-route', line: 1, result: 'pass', note: 'routes call one service' },
    { pattern: 'api-route', line: 2, result: 'pass', note: 'strictBody with its SHAPE' },
  ],
  criteria: [
    { criterion: 2, result: 'pass', reason: 'held', evidence: ['packages/core/src/x.ts'] },
  ],
  ...over,
});

const [LINE_1, LINE_2] = whole().checklist as [ReviewChecklistEntry, ReviewChecklistEntry];

const NOBODY: Builders = { sessions: new Set(), actors: new Set(), liveOnBox: false };
const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

describe('the lines a review owes', () => {
  it('owes each checklist line of each chosen pattern and each code-property criterion', () => {
    expect(OWED.checklist.map((l) => `${l.pattern}#${l.line}`)).toEqual([
      'api-route#1',
      'api-route#2',
    ]);
    expect(OWED.criteria).toEqual([{ criterion: 2, statement: 'criterion 2' }]);
    expect(OWED.noCatalog).toBeNull();
    expect(OWED.unread).toEqual([]);
  });

  it('owes no checklist line on a project that reads no catalog, and says why', () => {
    const owed = owedOf({
      design: { criteria: [line(1, 'code_property', null)] },
      catalog: UNDECLARED,
      entries: ENTRIES,
    });
    expect(owed.checklist).toEqual([]);
    expect(owed.criteria.map((c) => c.criterion)).toEqual([1]);
    expect(owed.noCatalog).toBe('this project reads no catalog');
  });

  it('names a chosen pattern this build holds no page for, and owes no line of it', () => {
    const owed = owedOf({
      design: { criteria: [line(1, 'observable', 'brand-new')] },
      catalog: READ,
      entries: ENTRIES,
    });
    expect(owed.checklist).toEqual([]);
    expect(owed.unread).toEqual(['brand-new']);
  });
});

describe('a review is refused by name', () => {
  it('takes a review giving one result per owed line', () => {
    expect(reviewRefusals(whole(), OWED)).toEqual([]);
  });

  it('refuses a checklist line left out', () => {
    const r = reviewRefusals(whole({ checklist: [LINE_1] }), OWED);
    expect(codes(r)).toEqual(['REVIEW_LINE_MISSING']);
    expect(r[0]?.detail).toContain('api-route#2');
  });

  it('refuses a code-property criterion left out', () => {
    const r = reviewRefusals(whole({ criteria: [] }), OWED);
    expect(codes(r)).toEqual(['REVIEW_LINE_MISSING']);
    expect(r[0]?.path).toBe('/criteria');
  });

  it('refuses a line of a pattern the design did not choose, and an observable criterion', () => {
    const r = reviewRefusals(
      whole({
        checklist: [
          ...whole().checklist,
          { pattern: 'screen', line: 1, result: 'pass', note: 'n' },
        ],
        criteria: [
          ...whole().criteria,
          { criterion: 1, result: 'pass', reason: 'r', evidence: ['e'] },
        ],
      }),
      OWED,
    );
    expect(codes(r)).toEqual(['REVIEW_LINE_UNKNOWN', 'REVIEW_LINE_UNKNOWN']);
    expect(r.map((x) => x.path)).toEqual(['/checklist/2', '/criteria/1']);
  });

  it('refuses a line sent twice', () => {
    const r = reviewRefusals(whole({ checklist: [LINE_1, LINE_2, LINE_1] }), OWED);
    expect(codes(r)).toEqual(['REVIEW_LINE_REPEATED']);
  });

  it('refuses an empty diff', () => {
    expect(codes(reviewRefusals(whole({ base: HEAD }), OWED))).toEqual(['REVIEW_REFUSED']);
  });

  it('refuses a start in the future or more than a day ago, naming startedAt', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    const at = (startedAt: string) => reviewRefusals(whole({ startedAt }), OWED, now);
    expect(at('2026-10-10T11:30:00Z')).toEqual([]);
    expect(at('2026-10-10T12:00:30Z')).toEqual([]);
    expect(at('2026-10-10T12:05:00Z').map((r) => r.path)).toEqual(['/startedAt']);
    expect(at('2026-10-09T11:59:00Z')[0]?.detail).toMatch(/more than a day ago/);
  });

  it('carries no rerun: a check, test or probe result is no key of a review', () => {
    for (const key of ['checks', 'tests', 'probes']) {
      const parsed = recordReviewRequestSchema.safeParse({ ...whole(), [key]: [] });
      expect(parsed.success, key).toBe(false);
    }
    expect(recordReviewRequestSchema.safeParse(whole()).success).toBe(true);
  });

  it('asks a note of every checklist line, so a skip says why', () => {
    const parsed = recordReviewRequestSchema.safeParse(
      whole({
        checklist: [{ pattern: 'api-route', line: 1, result: 'not_applicable', note: '' }],
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('a review is never the building run', () => {
  const builders: Builders = { sessions: new Set(['s-build']), actors: new Set(), liveOnBox: true };

  it('refuses the building run and names who may review', () => {
    const r = reviewerRefusal('ISS-9', { session: 's-build', box: 'box', actor: 'u' }, builders);
    expect(r?.code).toBe('REVIEW_BY_BUILDER');
    expect(r?.detail).toContain('Send `run`');
  });

  it('takes another run on the same box', () => {
    expect(
      reviewerRefusal('ISS-9', { session: 's-other', box: 'box', actor: 'u' }, builders),
    ).toBeNull();
  });

  it('refuses a box call naming no run while the building run is live there', () => {
    const r = reviewerRefusal('ISS-9', { session: null, box: 'box', actor: 'u' }, builders);
    expect(r?.code).toBe('REVIEW_RUN_UNNAMED');
    expect(r?.path).toBe('/run');
  });

  it('refuses a person who recorded the checks, and takes another person', () => {
    const byHand: Builders = { sessions: new Set(), actors: new Set(['me']), liveOnBox: false };
    expect(reviewerRefusal('ISS-9', { session: null, box: null, actor: 'me' }, byHand)?.code).toBe(
      'REVIEW_BY_BUILDER',
    );
    expect(reviewerRefusal('ISS-9', { session: null, box: null, actor: 'you' }, byHand)).toBeNull();
  });
});

describe('the record and the mark', () => {
  const evidence = {
    checks: [{ kind: 'tests', result: 'pass' }],
    mergeCheckPassed: true,
    verdicts: 2,
  };
  const reviewer = { session: 's-review', box: 'box', actor: 'u' };

  const stored = (body: RecordReviewRequest, who = reviewer) => {
    const review = storedReviewOf({
      id: 'r1',
      createdAt: new Date('2026-10-10T00:00:00Z'),
      fields: reviewRecordFields({ body, owed: OWED, reviewer: who, builders: NOBODY, evidence }),
    });
    if (!review) throw new Error('the record did not read back as a review');
    return review;
  };

  it('records one field per result, the diff, the evidence cited and that it reran nothing', () => {
    const fields = reviewRecordFields({
      body: whole(),
      owed: OWED,
      reviewer,
      builders: NOBODY,
      evidence,
    });
    const all = (key: string) => fields.filter((f) => f.key === key).map((f) => f.value);
    expect(all('line')).toHaveLength(2);
    expect(all('criterion')[0]).toMatch(/^2 pass: held \(packages\/core\/src\/x\.ts\)$/);
    expect(all('diff')).toEqual([`${BASE}..${HEAD}`]);
    expect(all('patterns')).toEqual(['api-route']);
    expect(all('evidence')[0]).toContain('a passing merge check');
    expect(all('reruns')[0]).toMatch(/^none: a review runs no check, test or probe/);
    expect(fields.every((f) => f.value.length <= 400)).toBe(true);
  });

  it('a review is a check of kind review, timed from its start to its record', () => {
    const view = reviewCheckViewOf(stored(whole({ startedAt: '2026-10-09T23:48:00Z' })));
    expect(view).toMatchObject({
      kind: 'review',
      result: 'pass',
      durationMs: 720_000,
      startedAt: '2026-10-09T23:48:00.000Z',
      runSessionId: 's-review',
      note: null,
    });
    const legacy = stored(whole());
    const untimed = reviewCheckViewOf({ ...legacy, startedAt: null });
    expect(untimed.durationMs).toBe(0);
    expect(untimed.note).toMatch(/^Untimed/);
  });

  it('a fail anywhere fails the review and names the line', () => {
    const body = whole({
      checklist: [
        { pattern: 'api-route', line: 1, result: 'fail', note: 'a query in the route' },
        LINE_2,
      ],
    });
    expect(outcomeOf(body)).toEqual({ result: 'fail', failed: ['api-route#1'] });
    expect(stored(body).failed).toEqual(['api-route#1']);
  });

  it('the mark passes only a passing review by another than the builder at the commit', () => {
    const pass = stored(whole());
    const base = { issueRef: 'ISS-9', builders: NOBODY };
    expect(unreviewedDetail({ ...base, commit: HEAD.slice(0, 9), reviews: [pass] })).toBeNull();
    expect(unreviewedDetail({ ...base, commit: 'c'.repeat(40), reviews: [pass] })).toContain(
      'no review is recorded at',
    );
    expect(unreviewedDetail({ ...base, commit: null, reviews: [pass] })).toContain(
      'names no commit',
    );
    const failing = stored(
      whole({ criteria: [{ criterion: 2, result: 'fail', reason: 'no', evidence: ['e'] }] }),
    );
    expect(unreviewedDetail({ ...base, commit: HEAD, reviews: [failing] })).toContain(
      'failed criterion 2',
    );
    const byBuilder = {
      ...base,
      builders: { sessions: new Set(['s-review']), actors: new Set<string>(), liveOnBox: false },
    };
    expect(unreviewedDetail({ ...byBuilder, commit: HEAD, reviews: [pass] })).toContain(
      'recorded by the building run',
    );
  });
});
