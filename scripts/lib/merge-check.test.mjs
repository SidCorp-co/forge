// @direct-test-of .github/workflows/ci.yml
// @direct-test-of packages/contracts/src/merge-check.ts
// @direct-test-of scripts/merge-check.mjs
//
// The merge check's rules (lib/merge-check.mjs) and where dev's CI runs it (Issue to release r20
// `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472): a change behind its base is refused by name,
// the checks every merge needs are the contract's, and a push to dev or a pull request into dev runs
// the merge check and no package's whole suite, while main's runs keep their jobs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  behindRefusal,
  dirtyRefusal,
  emptyRefusal,
  missingCheck,
  NOT_RUN_HERE,
  passedMessage,
  REQUIRED_CHECKS,
  redChecks,
  reportOf,
} from './merge-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
const CONTRACT = readFileSync(join(HERE, '../../packages/contracts/src/merge-check.ts'), 'utf8');
const CLI = readFileSync(join(HERE, '../merge-check.mjs'), 'utf8');

const TIP = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);

describe('a change is checked only as it would land', () => {
  it('refuses a change behind its base by name, saying how to rebase', () => {
    const refusal = behindRefusal({ branch: 'dev', tip: TIP, head: HEAD, tipInHead: false });
    expect(refusal).toMatch(/^MERGE_BEHIND_BASE: /);
    expect(refusal).toContain('git rebase origin/dev');
    expect(refusal).toContain(TIP.slice(0, 12));
    expect(behindRefusal({ branch: 'dev', tip: TIP, head: HEAD, tipInHead: true })).toBeNull();
  });

  it('refuses a checkout holding changes HEAD does not, naming them', () => {
    expect(dirtyRefusal(' M scripts/a.mjs\n?? scripts/b.mjs\n')).toContain(
      'scripts/a.mjs, scripts/b.mjs',
    );
    expect(dirtyRefusal('')).toBeNull();
  });

  it('refuses a change that touches nothing, pointing a landing at --since', () => {
    expect(emptyRefusal({ branch: 'dev', head: HEAD, touched: [] })).toContain('--since');
    expect(
      emptyRefusal({ branch: 'dev', head: HEAD, touched: [{ path: 'a', change: 'added' }] }),
    ).toBeNull();
  });

  it('the CLI refuses MERGE_BEHIND_BASE before it runs any test', () => {
    const behindAt = CLI.indexOf('behindRefusal({');
    expect(behindAt).toBeGreaterThan(-1);
    expect(behindAt).toBeLessThan(CLI.indexOf('runDirectTests('));
    expect(CLI).toContain("git', ['fetch', '--quiet', 'origin', branch]");
  });
});

describe('what a merge needs', () => {
  it('names the same checks as the contract core records against', () => {
    const listed = /REQUIRED_MERGE_CHECKS = \[([^\]]*)\]/.exec(CONTRACT)?.[1] ?? '';
    const names = [...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(REQUIRED_CHECKS);
  });

  it('finds the first required check a run did not make, and the red ones', () => {
    const made = REQUIRED_CHECKS.filter((n) => n !== 'integration-tests').map((name) => ({
      name,
      result: 'pass',
    }));
    expect(missingCheck(made)).toBe('integration-tests');
    expect(missingCheck([...made, { name: 'integration-tests', result: 'none' }])).toBeNull();
    expect(
      redChecks([
        { name: 'typecheck', result: 'fail' },
        { name: 'verify', result: 'pass' },
      ]),
    ).toEqual([{ name: 'typecheck', result: 'fail' }]);
  });

  it('says probes and review are not run here, each with the issue that builds it', () => {
    expect(NOT_RUN_HERE.map((n) => [n.name, n.owner])).toEqual([
      ['probes', 'ISS-469'],
      ['review', 'ISS-473'],
    ]);
  });

  it('a pre-merge pass asks for its record before the mark; a landed push says it is already on its base', () => {
    const at = { branch: 'dev', baseSha: TIP, head: HEAD, path: '/tmp/r.json' };
    const before = passedMessage({ ...at, mode: 'pre-merge' });
    expect(before).toContain('before the merge mark');
    expect(before).toContain('POST /api/issues/<issue id>/merge-check');
    const landed = passedMessage({ ...at, mode: 'landed' });
    expect(landed).toContain(
      `a landing already on dev (${TIP.slice(0, 12)}..${HEAD.slice(0, 12)})`,
    );
    expect(landed).not.toContain('before the merge mark');
    expect(CLI).toContain('passedMessage({ mode: report.mode');
  });

  it('writes the body the tracker takes', () => {
    const report = reportOf({
      branch: 'dev',
      baseSha: TIP,
      head: HEAD,
      mode: 'pre-merge',
      touched: [{ path: 'a.ts', change: 'changed' }],
      checks: [],
    });
    expect(Object.keys(report)).toEqual(['base', 'head', 'mode', 'touched', 'checks']);
    expect(report.base).toEqual({ branch: 'dev', sha: TIP });
  });
});

const JOBS = CI.slice(CI.indexOf('\njobs:\n'));

/** One job's block: its lines up to the next job at the same indent. */
function job(name) {
  const lines = JOBS.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`ci.yml has no job ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

const jobNames = () => [...JOBS.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);

const SCOPED = `(github.event_name == 'push' && github.ref == 'refs/heads/dev') || (github.event_name == 'pull_request' && github.base_ref == 'dev')`;

describe("dev's CI is the merge check, and main's is as it was", () => {
  it('runs on every push and pull request into dev: no path is ignored', () => {
    const on = CI.slice(CI.indexOf('\non:'), CI.indexOf('\n  schedule:'));
    expect(on).not.toContain('paths-ignore');
    expect(on).toContain('branches: [main, dev]');
  });

  it('switches on one output, true exactly for a push to dev or a pull request into dev', () => {
    expect(job('changes')).toContain(`scoped: \${{ ${SCOPED} }}`);
  });

  it('runs merge-check only there, under its own name, before ci-passed', () => {
    expect(job('merge-check')).toContain("if: needs.changes.outputs.scoped == 'true'");
    expect(job('merge-check')).toContain('pnpm merge-check');
    expect(job('merge-check')).toContain('github.event.pull_request.head.sha');
    const needs = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(CI)?.[1] ?? '';
    expect(needs.split(',').map((s) => s.trim())).toContain('merge-check');
    expect(job('ci-passed')).toContain(`"merge-check:\${{ needs.merge-check.result }}"`);
  });

  it('skips every other job there, so no package suite runs before a dev merge', () => {
    const own = new Set([
      'changes',
      'merge-check',
      'ci-passed',
      'whole-suite',
      'suite-bisect',
      'nightly-fanout',
    ]);
    for (const name of jobNames().filter((n) => !own.has(n))) {
      expect([name, job(name)]).toEqual([
        name,
        expect.stringContaining("needs.changes.outputs.scoped != 'true'"),
      ]);
    }
  });

  it('ci-passed reads merge-check on every run, before it decides', () => {
    expect(job('ci-passed')).toContain('if: always()');
  });

  it("keeps main's conditions as they were, each behind the switch", () => {
    expect(job('core')).toContain(
      "if: needs.changes.outputs.scoped != 'true' && ((needs.changes.outputs.proved != 'true' && (needs.changes.outputs.core == 'true' || needs.changes.outputs.scripts == 'true')) || github.event_name == 'schedule' || inputs.suite == 'whole')",
    );
    expect(job('images')).toContain(
      "if: needs.changes.outputs.scoped != 'true' && github.event_name != 'pull_request'",
    );
    expect(job('lang-check')).toContain("if: needs.changes.outputs.scoped != 'true'\n");
  });
});
