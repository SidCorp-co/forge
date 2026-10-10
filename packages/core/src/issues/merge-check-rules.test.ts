import { randomUUID } from 'node:crypto';
import { FAST_LANE_MERGE_CHECKS } from '@forge/contracts/fast-lane';
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
  probeRefusals,
  recordFields,
  warningsOf,
} from './merge-check-rules.js';

type Doc = Partial<MergeCheckReport['checks'][number]>;

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
  patchId: '7'.repeat(40),
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

describe("the change's kept probes (REQ-36 BC-1, BC-9)", () => {
  const PROBE_A = '11111111-1111-4111-8111-111111111111';
  const PROBE_B = '22222222-2222-4222-8222-222222222222';
  /** A report whose `probes` checks are `ran`, each bound to its criterion's probe. */
  const withProbes = (ran: { criterion: number; probe: string; over?: Doc }[]): MergeCheckReport => {
    const probeChecks = ran.map((r) => run('probes', { scope: `criterion ${r.criterion}`, ...r.over }));
    const others = REQUIRED_MERGE_CHECKS.filter((n) => n !== 'probes').map((n) => run(n));
    return {
      ...report([...others, ...(probeChecks.length ? probeChecks : [run('probes', { result: 'none' })])]),
      probes: ran.map((r, i) => ({
        criterion: r.criterion,
        probe: r.probe,
        check: probeChecks[i]?.id ?? '',
      })),
    };
  };
  const observable = (n: number, probe: string | null) => ({
    n,
    class: 'observable' as const,
    probe: probe ? { id: probe } : null,
  });

  it('takes a report that ran every kept probe green', () => {
    const r = withProbes([
      { criterion: 1, probe: PROBE_A },
      { criterion: 3, probe: PROBE_B },
    ]);
    expect(probeRefusals(r, [observable(1, PROBE_A), observable(3, PROBE_B)])).toEqual([]);
    expect(checkRefusal(r)).toBeNull();
    expect(recordFields(r).find((f) => f.key === 'probes')?.value).toBe(
      '2 kept probe(s) ran and held, for criteria 1, 3',
    );
  });

  it('refuses MERGE_PROBE_MISSING for a kept probe the report did not run, naming it', () => {
    const out = probeRefusals(withProbes([{ criterion: 1, probe: PROBE_A }]), [
      observable(1, PROBE_A),
      observable(2, PROBE_B),
    ]);
    expect(out.map((r) => r.code)).toEqual(['MERGE_PROBE_MISSING']);
    expect(out[0]?.detail).toContain(`criterion 2's kept probe ${PROBE_B} was not run`);
  });

  it('refuses MERGE_PROBE_MISSING for an observable criterion keeping no probe', () => {
    const out = probeRefusals(withProbes([]), [observable(4, null)]);
    expect(out[0]?.code).toBe('MERGE_PROBE_MISSING');
    expect(out[0]?.detail).toContain('criterion 4 is observable and keeps no probe');
  });

  it('refuses MERGE_PROBE_MISSING for a probe that could not run, and for an older probe', () => {
    const notRun = probeRefusals(
      withProbes([
        { criterion: 1, probe: PROBE_A, over: { result: 'none', note: 'could not run: no origin' } },
      ]),
      [observable(1, PROBE_A)],
    );
    expect(notRun[0]?.code).toBe('MERGE_PROBE_MISSING');
    expect(notRun[0]?.detail).toContain("criterion 1's kept probe did not run (could not run: no origin)");
    const stale = probeRefusals(withProbes([{ criterion: 1, probe: PROBE_B }]), [
      observable(1, PROBE_A),
    ]);
    expect(stale[0]?.detail).toContain(`criterion 1 keeps probe ${PROBE_A}, and the report ran ${PROBE_B}`);
  });

  it('refuses MERGE_PROBE_RED for a red probe, by its own name rather than MERGE_CHECK_RED', () => {
    const r = withProbes([
      { criterion: 1, probe: PROBE_A, over: { result: 'fail', note: 'it exited 1, expected 0' } },
    ]);
    expect(checkRefusal(r)).toBeNull();
    const out = probeRefusals(r, [observable(1, PROBE_A)]);
    expect(out.map((x) => x.code)).toEqual(['MERGE_PROBE_RED']);
    expect(out[0]?.detail).toContain('`probes` (criterion 1)');
    expect(out[0]?.detail).toContain('it exited 1, expected 0');
  });

  it('names both where a probe is missing and another is red', () => {
    const out = probeRefusals(
      withProbes([{ criterion: 1, probe: PROBE_A, over: { result: 'fail' } }]),
      [observable(1, PROBE_A), observable(2, null)],
    );
    expect(out.map((x) => x.code)).toEqual(['MERGE_PROBE_MISSING', 'MERGE_PROBE_RED']);
  });

  it('owes nothing for a code property, or an unclassed criterion keeping no probe', () => {
    const criteria = [
      { n: 1, class: 'code_property' as const, probe: null },
      { n: 2, class: null, probe: null },
    ];
    expect(probeRefusals(withProbes([]), criteria)).toEqual([]);
    expect(recordFields(withProbes([])).find((f) => f.key === 'probes')?.value).toBe(
      'no kept probe to run',
    );
  });

  it('still runs the kept probe of an unclassed criterion', () => {
    const out = probeRefusals(withProbes([]), [{ n: 5, class: null, probe: { id: PROBE_A } }]);
    expect(out[0]?.code).toBe('MERGE_PROBE_MISSING');
  });

  it('does not ask the fast lane, which runs no probes', () => {
    const fast: MergeCheckReport = {
      ...report(FAST_LANE_MERGE_CHECKS.map((n) => run(n))),
      lane: 'fast',
    };
    expect(probeRefusals(fast, [observable(1, PROBE_A)])).toEqual([]);
  });
});

describe('a report on the fast lane (REQ-39 BC-7)', () => {
  const PATCH = 'c'.repeat(40);
  const fast = (checks = FAST_LANE_MERGE_CHECKS.map((n) => run(n))): MergeCheckReport => ({
    ...report(checks),
    lane: 'fast',
    patchId: PATCH,
  });

  it('takes the typecheck and the touched tests alone: no integration tests, no verify', () => {
    expect(checkRefusal(fast())).toBeNull();
  });

  it('still refuses one missing a fast check, naming the fast lane', () => {
    const out = checkRefusal(
      fast(FAST_LANE_MERGE_CHECKS.filter((n) => n !== 'typecheck').map((n) => run(n))),
    );
    expect(out?.code).toBe('MERGE_CHECK_INCOMPLETE');
    expect(out?.detail).toContain('runs no `typecheck` check, and a fast-lane merge needs');
  });

  it('holds a report without a lane to every check a merge needs', () => {
    const out = checkRefusal(report(FAST_LANE_MERGE_CHECKS.map((n) => run(n))));
    expect(out?.code).toBe('MERGE_CHECK_INCOMPLETE');
    expect(out?.detail).toContain('`integration-tests`, `probes`, `verify`');
  });

  it('records the lane and the patch id it checked, on either lane', () => {
    const fields = recordFields(fast());
    expect(fields.find((f) => f.key === 'lane')?.value).toBe('fast');
    expect(fields.find((f) => f.key === 'patch-id')?.value).toBe(PATCH);
    expect(recordFields(report()).find((f) => f.key === 'lane')?.value).toBe('full');
    expect(recordFields(report()).find((f) => f.key === 'patch-id')?.value).toBe('7'.repeat(40));
    expect(warningsOf(report())).toEqual([]);
  });

  it('records an old-shape full report as absent and warns by name', () => {
    const { patchId: _old, ...old } = report();
    expect(recordFields(old).find((f) => f.key === 'patch-id')?.value).toBe(
      'absent (script predates patch ids)',
    );
    expect(warningsOf(old)[0]).toContain('PATCH_ID_ABSENT');
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
