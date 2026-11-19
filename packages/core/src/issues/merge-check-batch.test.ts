import { randomUUID } from 'node:crypto';
import {
  MERGE_CHECK_KINDS,
  type MergeCheckReport,
  REQUIRED_MERGE_CHECKS,
} from '@forge/contracts/merge-check';
import { describe, expect, it } from 'vitest';
import { reportForIssue } from './merge-check-batch.js';
import { probeRefusals } from './merge-check-rules.js';

const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ref: 'ISS-1' };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ref: 'ISS-2' };
const PROBE_A = '11111111-1111-4111-8111-111111111111';
const PROBE_B = '22222222-2222-4222-8222-222222222222';

const check = (name: (typeof REQUIRED_MERGE_CHECKS)[number], over: object = {}) => ({
  id: randomUUID(),
  kind: MERGE_CHECK_KINDS[name],
  name,
  startedAt: '2026-11-20T06:00:00.000Z',
  scope: 'workspace',
  command: `run ${name}`,
  files: [],
  result: 'pass' as const,
  durationMs: 1500,
  ...over,
});

/** A batch's report: A's probe on criterion 1 held, B's on criterion 1 ended red. */
function batch(): MergeCheckReport {
  const ranA = check('probes', { scope: `issue ${A.id}, criterion 1` });
  const ranB = check('probes', {
    scope: `issue ${B.id}, criterion 1`,
    result: 'fail',
    note: 'it exited 1',
  });
  return {
    base: { branch: 'dev', sha: 'b'.repeat(40) },
    head: 'a'.repeat(40),
    mode: 'pre-merge',
    touched: [{ path: 'packages/core/src/issues/x.ts', change: 'changed' }],
    checks: [
      ...REQUIRED_MERGE_CHECKS.filter((n) => n !== 'probes').map((n) => check(n)),
      ranA,
      ranB,
    ],
    issues: [
      { issue: A.id, probes: [{ criterion: 1, probe: PROBE_A, check: ranA.id }] },
      { issue: B.id, probes: [{ criterion: 1, probe: PROBE_B, check: ranB.id }] },
    ],
    patchId: '7'.repeat(40),
  };
}
const observable = (probe: string) => [
  { n: 1, class: 'observable' as const, probe: { id: probe } },
];
const asRead = (issue: typeof A) => {
  const own = reportForIssue(batch(), issue);
  if (!own.report) throw new Error(own.refusal.detail);
  return own.report;
};

// cleanup 21284cd0: the batch report's probes checks were read whole, so A was refused for B's red
describe('a batch report as one issue reads it (ISS-1294)', () => {
  it("holds an issue to its own probes checks, never another issue's red", () => {
    expect(probeRefusals(asRead(A), observable(PROBE_A))).toEqual([]);
    expect(
      asRead(A)
        .checks.filter((c) => c.kind === 'probes')
        .map((c) => c.scope),
    ).toEqual([`issue ${A.id}, criterion 1`]);
  });

  it('refuses the issue whose own probe ended red, naming that probe alone', () => {
    const out = probeRefusals(asRead(B), observable(PROBE_B));
    expect(out.map((r) => r.code)).toEqual(['MERGE_PROBE_RED']);
    expect(out[0]?.detail).toContain(`issue ${B.id}, criterion 1`);
    expect(out[0]?.detail).not.toContain(A.id);
  });

  it('names the batch form of --probes where a probe is missing', () => {
    const out = probeRefusals(asRead(A), [
      ...observable(PROBE_A),
      { n: 2, class: 'observable', probe: null },
    ]);
    expect(out.map((r) => r.code)).toEqual(['MERGE_PROBE_MISSING']);
    expect(out[0]?.detail).toContain('--probes <issue id>=<its criteria read>');
  });
});
