/**
 * A red integration test the merge check reran (ISS-1120): red at the merge base too is `base-red`,
 * green on a rerun at the head is `flaky`, and neither is the change's, so a report whose only reds
 * are those is recorded as passing, naming them apart; a red the base does not share is refused as
 * every red was before.
 */
import { randomUUID } from 'node:crypto';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  mergeCheckReportSchema,
  REQUIRED_MERGE_CHECKS,
  type RequiredMergeCheck,
} from '@forge/contracts/merge-check';
import { describe, expect, it } from 'vitest';
import { checkRefusal, recordFields } from './merge-check-rules.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FULL = { fastDelivery: false, debtIds: [] } as const;
const RED = 'packages/core/tests/integration/slow-reads-at-scale.test.ts';
const GREEN = 'packages/core/tests/integration/other-e2e.test.ts';

const run = (name: RequiredMergeCheck, over: Partial<MergeCheckReport['checks'][number]> = {}) => ({
  id: randomUUID(),
  kind: MERGE_CHECK_KINDS[name],
  name,
  startedAt: '2026-11-07T06:00:00.000Z',
  scope: name === 'integration-tests' ? '@forge/core integration' : 'workspace',
  command: `run ${name}`,
  files: [],
  result: 'pass' as const,
  durationMs: 1500,
  ...over,
});

/** A full report whose integration run went red over RED (and held GREEN). */
function redOver() {
  const checks = REQUIRED_MERGE_CHECKS.map((n) =>
    run(n, n === 'integration-tests' ? { result: 'fail', files: [RED, GREEN] } : {}),
  );
  const integration = checks.find((c) => c.name === 'integration-tests');
  if (!integration) throw new Error('no integration check');
  return { checks, integration };
}

const at = (
  where: 'head' | 'base',
  result: 'pass' | 'fail' | 'absent' | 'error',
  failed: string[] = ['slow reads > reads one page'],
) => ({
  at: where,
  sha: where === 'head' ? HEAD : BASE,
  result,
  command: `(cd packages/core && pnpm exec vitest run --config vitest.integration.config.ts ${RED})`,
  startedAt: '2026-11-07T06:05:00.000Z',
  durationMs: 9000,
  ...(result === 'fail' ? { failed } : {}),
});

const withReruns = (checks: MergeCheckReport['checks'], reruns: unknown[]) =>
  mergeCheckReportSchema.parse({
    base: { branch: 'dev', sha: BASE },
    head: HEAD,
    mode: 'pre-merge',
    touched: [{ path: 'README.md', change: 'changed' }],
    checks,
    reruns,
    patchId: '7'.repeat(40),
  });

describe('an integration red the base holds too, or one that flips (ISS-1120)', () => {
  it('takes a report whose only red is base-red, and records it as passing, naming it apart', () => {
    const { checks, integration } = redOver();
    const report = withReruns(checks, [
      {
        check: integration.id,
        file: RED,
        verdict: 'base-red',
        runs: [at('head', 'fail'), at('base', 'fail')],
      },
    ]);
    expect(checkRefusal(report)).toBeNull();
    const fields = recordFields(report, [], FULL);
    const field = (key: string) => fields.find((f) => f.key === key)?.value ?? '';
    expect(field('result')).toBe('pass');
    expect(field('lead')).toContain('1 base-red');
    expect(field('base-red')).toContain(RED);
    expect(field('base-red')).toContain(`fail at ${BASE.slice(0, 12)}`);
    expect(field('flaky')).toBe('');
  });

  it('takes a report whose only red flipped green on its rerun at the head, naming it flaky', () => {
    const { checks, integration } = redOver();
    const report = withReruns(checks, [
      { check: integration.id, file: RED, verdict: 'flaky', runs: [at('head', 'pass')] },
    ]);
    expect(checkRefusal(report)).toBeNull();
    const fields = recordFields(report, [], FULL);
    expect(fields.find((f) => f.key === 'flaky')?.value).toContain(RED);
  });

  it('refuses a red the base does not share as the change’s own, naming the file', () => {
    const { checks, integration } = redOver();
    const report = withReruns(checks, [
      {
        check: integration.id,
        file: RED,
        verdict: 'branch-red',
        runs: [at('head', 'fail'), at('base', 'pass')],
      },
    ]);
    const out = checkRefusal(report);
    expect(out?.code).toBe('MERGE_CHECK_RED');
    expect(out?.detail).toContain(RED);
    expect(out?.detail).toContain('green at the merge base');
  });

  it('refuses a red integration run no rerun classed, as before', () => {
    const { checks } = redOver();
    expect(checkRefusal(withReruns(checks, []))?.code).toBe('MERGE_CHECK_RED');
  });

  it('never lets a rerun excuse any other check', () => {
    const { checks, integration } = redOver();
    const typecheck = checks.find((c) => c.name === 'typecheck');
    if (!typecheck) throw new Error('no typecheck');
    typecheck.result = 'fail';
    const report = withReruns(checks, [
      {
        check: integration.id,
        file: RED,
        verdict: 'base-red',
        runs: [at('head', 'fail'), at('base', 'fail')],
      },
    ]);
    expect(checkRefusal(report)?.detail).toContain('`typecheck`');
  });
});

describe('the reruns a report may name', () => {
  const parse = (reruns: unknown[]) => {
    const { checks, integration } = redOver();
    return {
      integration,
      result: (rs: (id: string) => unknown[]) =>
        mergeCheckReportSchema.safeParse({
          base: { branch: 'dev', sha: BASE },
          head: HEAD,
          mode: 'pre-merge',
          touched: [{ path: 'README.md', change: 'changed' }],
          checks,
          reruns: rs(integration.id),
          patchId: '7'.repeat(40),
        }),
      reruns,
    };
  };

  it('refuses a verdict its runs do not bear out, by name', () => {
    const { result } = parse([]);
    const out = result((id) => [
      { check: id, file: RED, verdict: 'base-red', runs: [at('head', 'fail'), at('base', 'pass')] },
    ]);
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain('branch-red');
    const other = result((id) => [
      {
        check: id,
        file: RED,
        verdict: 'base-red',
        runs: [at('head', 'fail', ['slow reads > reads two pages']), at('base', 'fail')],
      },
    ]);
    expect(other.success).toBe(false);
    expect(JSON.stringify(other.error?.issues)).toContain('branch-red');
  });

  it('refuses a rerun of a file its check did not run, or of a check that did not go red', () => {
    const { result } = parse([]);
    const out = result((id) => [
      {
        check: id,
        file: 'packages/core/tests/integration/never.test.ts',
        verdict: 'flaky',
        runs: [at('head', 'pass')],
      },
    ]);
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain('did not run');
  });

  it('refuses a rerun with no run at the head checked', () => {
    const { result } = parse([]);
    const out = result((id) => [
      { check: id, file: RED, verdict: 'base-red', runs: [at('base', 'fail')] },
    ]);
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain('once at the head');
  });
});
