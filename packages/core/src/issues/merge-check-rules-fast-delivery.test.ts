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
import { checkRefusal, recordFields } from './merge-check-rules.js';

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

  describe('the record a pass is kept as', () => {
    const DEBT = '0d5c1a8e-5f4b-4a3e-9c1d-2b7e6f8a9c10';
    const debt = {
      kind: 'red',
      check: 'verify',
      where: 'scripts',
      detail: 'copy budget',
      impact,
    } as const;
    const field = (fields: { key: string; value: string }[], key: string) =>
      fields.find((f) => f.key === key)?.value;

    it('names the red it passed as cleanup debt, by its check and its debt id, never as a clean pass', () => {
      const checks = [...fastChecks(), run('verify', { result: 'fail' })];
      const fields = recordFields({ ...report(checks), debts: [debt] }, [], {
        fastDelivery: true,
        debtIds: [DEBT],
      });
      const lead = field(fields, 'lead') ?? '';
      expect(lead).toContain('`verify` ended red and passed as cleanup debt');
      expect(lead).toContain(DEBT);
      expect(field(fields, 'debts')).toContain(`red \`verify\` passed, debt ${DEBT}`);
    });

    it('says nothing of debt where every check held', () => {
      const fields = recordFields(report(fastChecks()), [], { fastDelivery: true, debtIds: [] });
      expect(field(fields, 'lead')).not.toContain('debt');
      expect(field(fields, 'debts')).toBeUndefined();
    });

    it('refuses to write a record whose debts the ledger did not answer an id for', () => {
      const checks = [...fastChecks(), run('verify', { result: 'fail' })];
      expect(() =>
        recordFields({ ...report(checks), debts: [debt] }, [], { fastDelivery: true, debtIds: [] }),
      ).toThrow(/1 debt\(s\).*0 id\(s\)/);
    });

    it('reads the lane the merge was held to: fast delivery, the fast lane, or the full one', () => {
      const lane = (fastDelivery: boolean, over: Partial<MergeCheckReport> = {}) =>
        field(
          recordFields({ ...report(fastChecks()), ...over }, [], { fastDelivery, debtIds: [] }),
          'lane',
        );
      expect(lane(true)).toBe('fast-delivery');
      expect(lane(true, { lane: 'full' })).toBe('fast-delivery');
      expect(lane(true, { lane: 'fast' })).toBe('fast');
      expect(lane(false)).toBe('full');
      expect(lane(false, { lane: 'fast' })).toBe('fast');
    });
  });
});
