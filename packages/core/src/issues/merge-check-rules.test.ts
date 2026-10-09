import { randomUUID } from 'node:crypto';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';
import { describe, expect, it } from 'vitest';
import {
  checkRefusal,
  headMatches,
  missingCheckDetail,
  passingHeads,
  recordFields,
} from './merge-check-rules.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

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
});

describe('which report a merge may rely on', () => {
  it('takes one that ran every required check green, a selection that held nothing included', () => {
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'integration-tests' ? { result: 'none' } : {}),
    );
    expect(checkRefusal(report(checks))).toBeNull();
  });

  it('refuses one missing a required check, naming it, before anything else', () => {
    const checks = REQUIRED_MERGE_CHECKS.filter((n) => n !== 'verify').map((n) =>
      run(n, n === 'typecheck' ? { result: 'fail' } : {}),
    );
    const out = checkRefusal(report(checks));
    expect(out?.code).toBe('MERGE_CHECK_INCOMPLETE');
    expect(out?.detail).toContain('`verify`');
  });

  it('refuses a required check filed under another kind, naming the check and its kind', () => {
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'verify' ? { kind: 'tests' } : {}),
    );
    const out = checkRefusal(report(checks));
    expect(out?.code).toBe('MERGE_CHECK_KIND_MISMATCH');
    expect(out?.detail).toContain('`verify` is a conformance check, not tests');
  });

  it('refuses a change behind its base by name, ahead of a red check', () => {
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(n, n === 'rebased-on-base' || n === 'typecheck' ? { result: 'fail' } : {}),
    );
    const out = checkRefusal(report(checks));
    expect(out?.code).toBe('MERGE_BEHIND_BASE');
    expect(out?.detail).toContain(BASE.slice(0, 12));
  });

  it('refuses a red check naming the check, its scope and its files', () => {
    const checks = REQUIRED_MERGE_CHECKS.map((n) =>
      run(
        n,
        n === 'direct-tests'
          ? { result: 'fail', scope: 'web-v2', files: ['packages/web-v2/src/a.test.ts'] }
          : {},
      ),
    );
    const out = checkRefusal(report(checks));
    expect(out?.code).toBe('MERGE_CHECK_RED');
    expect(out?.detail).toContain('`direct-tests` (web-v2): packages/web-v2/src/a.test.ts');
  });
});

describe('the record a passing check is kept as', () => {
  it('names each check it ran and carries no second copy of any duration', () => {
    const checks = [
      ...REQUIRED_MERGE_CHECKS.map((n) => run(n)),
      run('direct-tests', { scope: 'runner/runner-core', files: ['a.rs'], durationMs: 2500 }),
    ];
    const fields = recordFields(report(checks));
    const keys = fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(fields.find((f) => f.key === 'check')?.value).toBe('merge');
    expect(fields.find((f) => f.key === 'head')?.value).toBe(HEAD);
    const named = fields.find((f) => f.key === 'checks')?.value ?? '';
    expect(named).toContain('6 recorded with their kinds and durations');
    expect(named).toContain('direct-tests (runner/runner-core)');
    expect(fields.find((f) => f.key === 'not-checked')?.value).toContain('ISS-469');
    // One check is one record (ISS-474): its duration lives in its check run, never here as well.
    for (const f of fields) expect(f.value).not.toMatch(/\d+\.\ds\b|durationMs|\b1500\b|\b2500\b/);
  });

  it('cuts a long list of checks to fit one field, saying how many more there are', () => {
    const checks = [
      ...REQUIRED_MERGE_CHECKS.map((n) => run(n)),
      ...Array.from({ length: 40 }, (_, i) => run('direct-tests', { scope: `collection-${i}` })),
    ];
    const named = recordFields(report(checks)).find((f) => f.key === 'checks')?.value ?? '';
    expect(named.length).toBeLessThanOrEqual(400);
    expect(named).toMatch(/, \+\d+ more$/);
  });
});

describe('whether a mark finds a passing check at the commit it marks', () => {
  const recorded = { fields: recordFields(report()) };
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
    expect(headMatches([HEAD], HEAD)).toBe(true);
    expect(headMatches([HEAD], HEAD.slice(0, 9).toUpperCase())).toBe(true);
    expect(headMatches([HEAD], BASE)).toBe(false);
    expect(headMatches([], HEAD)).toBe(false);
  });

  it('says what was owed, at which commit, and what stands', () => {
    const detail = missingCheckDetail({
      issueRef: 'ISS-9',
      owedBy: 'project',
      commit: BASE,
      heads: [HEAD],
    });
    expect(detail).toContain('`validation.mergeCheck: required`');
    expect(detail).toContain(`no passing merge check is recorded at ${BASE}`);
    expect(detail).toContain(HEAD.slice(0, 12));
    expect(
      missingCheckDetail({ issueRef: 'ISS-9', owedBy: 'pattern', commit: null, heads: [] }),
    ).toContain('ISS-9 introduces an approved new pattern');
  });
});
