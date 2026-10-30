import type { CleanupReportRequest } from '@forge/contracts/cleanup';
import { describe, expect, it } from 'vitest';
import { cleanupBrief, debtRefusals, reportRefusals, waitingOnCleanup } from './rules.js';

const impact = (rating: 'low' | 'medium' | 'high') =>
  ({ type: 'data', rating, reason: `rated ${rating}` }) as const;
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const report = (over: Partial<CleanupReportRequest> = {}): CleanupReportRequest => ({
  base: { branch: 'dev', sha: 'c'.repeat(40) },
  result: 'green',
  cleared: [],
  remains: [],
  ...over,
});
const open = [
  { id: D1, where: 'packages/core/src/a.ts' },
  { id: D2, where: 'scripts/gate.mjs' },
];

describe('debt an agent records (REQ-79 BC-3)', () => {
  it('takes a red rated low or medium, and refuses a red rated high: it holds its issue', () => {
    const red = (rating: 'low' | 'medium' | 'high') => ({
      kind: 'red' as const,
      check: 'verify',
      where: 'scripts',
      detail: 'copy budget over',
      impact: impact(rating),
    });
    expect(debtRefusals([red('low'), red('medium')])).toEqual([]);
    const refused = debtRefusals([red('medium'), red('high')]);
    expect(refused.map((r) => [r.code, r.path])).toEqual([
      ['DEBT_RED_HOLDS_THE_ISSUE', '/items/1/impact/rating'],
    ]);
  });

  it('takes debt and simplification rated high: only a red holds its issue', () => {
    expect(
      debtRefusals([{ kind: 'debt', where: 'x', detail: 'y', impact: impact('high') }]),
    ).toEqual([]);
  });
});

describe('what a cleanup report owes (REQ-79 BC-9)', () => {
  it('names every open debt once, cleared with how or remaining with why', () => {
    const whole = report({ cleared: [{ debt: D1, how: 'fixed' }], remains: [{ debt: D2, why: 'needs a person' }] });
    expect(reportRefusals(whole, open, [])).toEqual([]);
    const short = reportRefusals(report({ cleared: [{ debt: D1, how: 'fixed' }] }), open, []);
    expect(short.map((r) => r.code)).toEqual(['CLEANUP_REPORT_INCOMPLETE']);
    expect(short[0]?.detail).toContain(D2);
    expect(short[0]?.detail).toContain('scripts/gate.mjs');
  });

  it('refuses a debt that is not open, and one named twice', () => {
    const twice = report({
      cleared: [{ debt: D1, how: 'fixed' }],
      remains: [{ debt: D1, why: 'not fixed' }, { debt: D2, why: 'later' }],
    });
    expect(reportRefusals(twice, open, []).map((r) => r.code)).toEqual(['CLEANUP_DEBT_NAMED_TWICE']);
    const stranger = report({
      cleared: [{ debt: '33333333-3333-4333-8333-333333333333', how: 'x' }],
      remains: [{ debt: D1, why: 'a' }, { debt: D2, why: 'b' }],
    });
    expect(reportRefusals(stranger, open, []).map((r) => r.code)).toEqual(['CLEANUP_DEBT_UNKNOWN']);
  });

  it('covers only on green, and only a change rated high now', () => {
    const remains = [{ debt: D1, why: 'a' }, { debt: D2, why: 'b' }];
    const high = { ref: 'ISS-1', issueId: 'i1', key: 'ISS-1', rating: 'high' as const };
    const medium = { ref: 'ISS-2', issueId: 'i2', key: 'ISS-2', rating: 'medium' as const };
    const none = { ref: 'ISS-9', issueId: null, key: null, rating: null };
    expect(reportRefusals(report({ remains }), open, [high])).toEqual([]);
    expect(
      reportRefusals(report({ remains, result: 'red' }), open, [high]).map((r) => r.code),
    ).toEqual(['CLEANUP_COVERS_RED']);
    expect(reportRefusals(report({ remains }), open, [medium, none]).map((r) => r.path)).toEqual([
      '/covers/0',
      '/covers/1',
    ]);
  });
});

describe('which changes wait for a green cleanup (REQ-79 BC-5, BC-6)', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 30, 10, m));
  const rated = [
    { issueId: 'high', impact: impact('high'), ratedAt: at(0) },
    { issueId: 'medium', impact: impact('medium'), ratedAt: at(0) },
    { issueId: 'low', impact: impact('low'), ratedAt: at(0) },
    { issueId: 'covered', impact: impact('high'), ratedAt: at(0) },
    { issueId: 'rerated', impact: impact('high'), ratedAt: at(10) },
  ];
  it('holds a change rated high no green report since covers, and nothing rated lower', () => {
    const covered = new Map([
      ['covered', at(5)],
      ['rerated', at(5)],
    ]);
    expect(waitingOnCleanup(rated, covered).map((r) => r.issueId)).toEqual(['high', 'rerated']);
  });
});

describe("a cleanup run's brief (REQ-79 BC-7)", () => {
  it('names the debt, the changes waiting, its fire and the report it owes', () => {
    const brief = cleanupBrief({
      projectId: 'p1',
      fireId: 'f1',
      debts: [{ id: D1, kind: 'red', check: 'verify', where: 'scripts', rating: 'medium', issueKey: 'ISS-4' }],
      waiting: [{ key: 'ISS-7', reason: 'a migration' }],
    });
    expect(brief).toContain(D1);
    expect(brief).toContain('ISS-7');
    expect(brief).toContain('"f1"');
    expect(brief).toContain('/api/projects/p1/cleanup-reports');
    expect(brief).toContain("never take a delivery run's");
  });
});
