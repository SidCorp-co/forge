/** The record a passing merge check is kept as, and whether a mark finds one covering its commit (REQ-79 BC-5). */
import { randomUUID } from 'node:crypto';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';
import { describe, expect, it } from 'vitest';
import { missingCheckDetail, passingHeads, passingRanges, rangeCovers, recordFields } from './merge-check-rules.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
/** A project that turned fast delivery off, whose report recorded no debt. */
const FULL = { fastDelivery: false, debtIds: [] } as const;

const run = (name: RequiredMergeCheck, over: Partial<MergeCheckReport['checks'][number]> = {}) => ({
  id: randomUUID(),
  kind: MERGE_CHECK_KINDS[name],
  name,
  startedAt: '2026-10-09T06:00:00.000Z',
  scope: 'workspace',
  command: `run ${name}`,
  files: [],
  result: 'pass' as const,
  durationMs: 1500,
  ...over,
});

const report = (checks = REQUIRED_MERGE_CHECKS.map((n) => run(n))): MergeCheckReport => ({
  base: { branch: 'dev', sha: BASE },
  head: HEAD,
  mode: 'pre-merge',
  touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
  checks,
  patchId: '7'.repeat(40),
});

describe('the record a passing check is kept as', () => {
  it('names each check it ran and carries no second copy of any duration', () => {
    const checks = [
      ...REQUIRED_MERGE_CHECKS.map((n) => run(n)),
      run('direct-tests', { scope: 'runner/runner-core', files: ['a.rs'], durationMs: 2500 }),
    ];
    const fields = recordFields(report(checks), [], FULL);
    const keys = fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(fields.find((f) => f.key === 'check')?.value).toBe('merge');
    expect(fields.find((f) => f.key === 'head')?.value).toBe(HEAD);
    const named = fields.find((f) => f.key === 'checks')?.value ?? '';
    expect(named).toContain('7 recorded with their kinds and durations');
    expect(named).toContain('direct-tests (runner/runner-core)');
    const notChecked = fields.find((f) => f.key === 'not-checked')?.value ?? '';
    expect(notChecked).toContain('the review');
    expect(notChecked).not.toContain('probe');
    expect(fields.find((f) => f.key === 'probes')?.value).toBe(
      '1 kept probe(s) ran and held, for criteria ',
    );
    // One check is one record (ISS-474): its duration lives in its check run, never here as well.
    for (const f of fields) expect(f.value).not.toMatch(/\d+\.\ds\b|durationMs|\b1500\b|\b2500\b/);
  });

  it('cuts a long list of checks to fit one field, saying how many more there are', () => {
    const checks = [
      ...REQUIRED_MERGE_CHECKS.map((n) => run(n)),
      ...Array.from({ length: 40 }, (_, i) => run('direct-tests', { scope: `collection-${i}` })),
    ];
    const named =
      recordFields(report(checks), [], FULL).find((f) => f.key === 'checks')?.value ?? '';
    expect(named.length).toBeLessThanOrEqual(400);
    expect(named).toMatch(/, \+\d+ more$/);
  });
});

describe('whether a mark finds a passing check at the commit it marks', () => {
  const recorded = { fields: recordFields(report(), [], FULL) };
  const other = {
    fields: [
      { key: 'check', value: 'something-else' },
      { key: 'head', value: BASE },
    ],
  };

  it('reads the heads of passing merge checks only', () => {
    expect(passingHeads([recorded, other])).toEqual([HEAD]);
  });

  it('matches a whole or abbreviated commit, and nothing else', () => {
    const ranges = passingRanges([recorded, other]);
    expect(rangeCovers(ranges, HEAD)).toBe(true);
    expect(rangeCovers(ranges, HEAD.slice(0, 9).toUpperCase())).toBe(true);
    expect(rangeCovers(ranges, BASE)).toBe(false);
    expect(rangeCovers([], HEAD)).toBe(false);
  });

  // ISS-845 (REQ-79 BC-5): a batch lands its issues, then fixes forward; the batch's later passing
  // check covers each commit its range holds, and a range that does not hold the commit covers nothing
  it('covers a commit its range base..head holds, and refuses one outside it', () => {
    const LANDED = 'd'.repeat(40);
    const OUTSIDE = 'e'.repeat(40);
    const batch = { fields: recordFields({ ...report(), commits: [LANDED, HEAD] }, [], FULL) };
    const ranges = passingRanges([batch]);
    expect(ranges).toEqual([{ base: BASE, head: HEAD, commits: [LANDED, HEAD] }]);
    expect(rangeCovers(ranges, LANDED)).toBe(true);
    expect(rangeCovers(ranges, LANDED.slice(0, 12))).toBe(true);
    expect(rangeCovers(ranges, OUTSIDE)).toBe(false);
    const detail = missingCheckDetail({
      issueRef: 'ISS-9',
      owedBy: 'cleanup',
      commit: OUTSIDE,
      ranges,
    });
    expect(detail).toContain(`no passing merge check covers ${OUTSIDE}`);
    expect(detail).toContain(`${BASE.slice(0, 12)}..${HEAD.slice(0, 12)} (2 commit(s))`);
  });

  it('says what was owed, at which commit, and what stands', () => {
    const detail = missingCheckDetail({
      issueRef: 'ISS-9',
      owedBy: 'project',
      commit: BASE,
      ranges: passingRanges([recorded]),
    });
    expect(detail).toContain('`validation.mergeCheck: required`');
    expect(detail).toContain(`no passing merge check covers ${BASE}`);
    expect(detail).toContain(HEAD.slice(0, 12));
    expect(
      missingCheckDetail({ issueRef: 'ISS-9', owedBy: 'pattern', commit: null, ranges: [] }),
    ).toContain('ISS-9 introduces an approved new pattern');
  });
});
