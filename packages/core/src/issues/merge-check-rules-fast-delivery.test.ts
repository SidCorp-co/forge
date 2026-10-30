// @direct-test-of packages/core/src/issues/merge-check-rules.ts
// A merge on a project delivering fast (REQ-79), apart from the full lane's cases beside it.

import { randomUUID } from 'node:crypto';
import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';
import { describe, expect, it } from 'vitest';
import { checkRefusal } from './merge-check-rules.js';

type Doc = Partial<MergeCheckReport['checks'][number]>;

const run = (name: RequiredMergeCheck, over: Doc = {}) => ({
  id: randomUUID(),
  kind: MERGE_CHECK_KINDS[name],
  name,
  startedAt: '2026-10-30T06:00:00.000Z',
  scope: 'workspace',
  command: `run ${name}`,
  files: [],
  result: 'pass' as const,
  durationMs: 1500,
  ...over,
});

const report = (checks: MergeCheckReport['checks']): MergeCheckReport => ({
  base: { branch: 'dev', sha: 'b'.repeat(40) },
  head: 'a'.repeat(40),
  mode: 'pre-merge',
  touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
  checks,
  patchId: '7'.repeat(40),
});

describe('a merge on a project delivering fast (REQ-79)', () => {
  const impact = {
    type: 'logic',
    rating: 'medium',
    reason: 'a flaky wait, not this change',
  } as const;
  const fastChecks = (over: Partial<Record<RequiredMergeCheck, Doc>> = {}) =>
    FAST_LANE_MERGE_CHECKS.map((n) => run(n, over[n] ?? {}));

  it('lands on build and its scoped tests, where the full lane asks every check (BC-2)', () => {
    expect(checkRefusal(report(fastChecks()), true)).toBeNull();
    expect(checkRefusal(report(fastChecks()), false)?.code).toBe('MERGE_CHECK_INCOMPLETE');
    expect(checkRefusal(report(fastChecks()))?.code).toBe('MERGE_CHECK_INCOMPLETE');
  });

  it('passes a red it names as cleanup debt rated below high, and only that red (BC-3)', () => {
    const checks = [...fastChecks(), run('verify', { result: 'fail' })];
    const debt = {
      kind: 'red',
      check: 'verify',
      where: 'scripts',
      detail: 'copy budget',
      impact,
    } as const;
    expect(checkRefusal({ ...report(checks), debts: [debt] }, true)).toBeNull();
    const unnamed = checkRefusal(report(checks), true);
    expect(unnamed?.code).toBe('MERGE_CHECK_RED');
    expect(unnamed?.detail).toContain('debts');
    const other = checkRefusal({ ...report(checks), debts: [{ ...debt, check: 'lint' }] }, true);
    expect(other?.code).toBe('MERGE_CHECK_RED');
  });

  it('never passes a base it is behind as debt', () => {
    const checks = fastChecks({ 'rebased-on-base': { result: 'fail' } });
    const debt = {
      kind: 'red',
      check: 'rebased-on-base',
      where: 'git',
      detail: 'behind',
      impact,
    } as const;
    expect(checkRefusal({ ...report(checks), debts: [debt] }, true)?.code).toBe(
      'MERGE_BEHIND_BASE',
    );
  });

  it('refuses debt by name where the project turned fast delivery off (BC-1)', () => {
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'verify' ? { result: 'fail' } : {}),
    );
    const debt = {
      kind: 'red',
      check: 'verify',
      where: 'scripts',
      detail: 'copy budget',
      impact,
    } as const;
    expect(checkRefusal({ ...report(checks), debts: [debt] }, false)?.code).toBe(
      'MERGE_DEBT_FAST_DELIVERY_OFF',
    );
  });
});
