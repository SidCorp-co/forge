// @direct-test-of scripts/merge-check.mjs
// @direct-test-of scripts/lib/merge-check.mjs
// @direct-test-of packages/contracts/src/merge-check.ts
//
// The merge check's reruns of a red integration test (ISS-1120): each red file once at the head,
// and where it stays red once at the merge base in a worktree of its own, removed after. Red at the
// base too is base-red, green again is flaky, and neither refuses the change; a red the base does not
// share is refused as before.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// The contract's own copy, as core loads it: built, since a script cannot import a workspace package.
import {
  rerunVerdictOf as contractVerdictOf,
  RERUN_RESULTS,
} from '../../packages/contracts/dist/merge-check.js';
import { redChecks, reportOf } from './merge-check.mjs';
import {
  baseWorktreePath,
  recordingExec,
  redFilesOf,
  rerunLines,
  rerunReds,
  rerunVerdictOf,
} from './merge-check-reruns.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const RED = 'packages/core/tests/integration/slow-reads-at-scale.test.ts';
const GREEN = 'packages/core/tests/integration/other-e2e.test.ts';

/** The throwaway repositories the cases made, removed once they have run. */
const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository for the worktree path, and a red integration check whose run left its JSON. */
function world({ json = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'merge-check-reruns-'));
  made.push(root);
  const check = {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'tests',
    name: 'integration-tests',
    scope: '@forge/core integration',
    command: '(cd packages/core && pnpm exec vitest run …)',
    files: [RED, GREEN],
    result: 'fail',
    durationMs: 1,
    startedAt: new Date().toISOString(),
  };
  const out = join(root, 'run-0.json');
  if (json) {
    writeFileSync(
      out,
      JSON.stringify({
        testResults: [
          { name: join(root, RED), status: 'failed' },
          { name: join(root, GREEN), status: 'passed' },
        ],
      }),
    );
  }
  return {
    root,
    check,
    calls: [{ cwd: join(root, 'packages/core'), files: [RED, GREEN], json: out }],
  };
}

const ONE = 'slow reads at scale > reads one page';
const TWO = 'slow reads at scale > reads two pages';

/**
 * An exec standing in for the commands: the rerun at the head and at the base end as told, a red one
 * writing a vitest JSON report naming `headFailed` or `baseFailed` failed (`null` writes none).
 */
function fakeExec({
  head,
  base,
  install = true,
  baseHolds = true,
  headFailed = [ONE],
  baseFailed = [ONE],
}) {
  const ran = [];
  const exec = (argv, cwd) => {
    ran.push({ argv, cwd });
    const ok = (yes) => ({
      ok: yes,
      status: yes ? 0 : 1,
      stdout: '',
      stderr: '',
      startedAt: Date.now(),
      durationMs: 5,
    });
    if (argv[0] === 'git' && argv[2] === 'add') {
      const path = argv[4];
      mkdirSync(join(path, 'packages/core/tests/integration'), { recursive: true });
      if (baseHolds) writeFileSync(join(path, RED), '');
      return ok(true);
    }
    if (argv[0] === 'git') return ok(true);
    if (argv.includes('install')) return ok(install);
    const atBase = cwd.includes('merge-check-base-');
    const passed = (atBase ? base : head) === 'pass';
    const out = argv.find((a) => a.startsWith('--outputFile.json='))?.slice(18);
    const failed = atBase ? baseFailed : headFailed;
    if (!passed && out && failed) {
      const assertionResults = failed.map((fullName) => ({ fullName, status: 'failed' }));
      writeFileSync(out, JSON.stringify({ testResults: [{ status: 'failed', assertionResults }] }));
    }
    return ok(passed);
  };
  return { exec, ran };
}

const rebuild = () => ({ built: [], refusal: null });
const reran = (w, exec) =>
  rerunReds({
    root: w.root,
    commonGitDir: join(w.root, '.git'),
    head: HEAD,
    base: BASE,
    checks: [w.check],
    calls: w.calls,
    exec,
    rebuild,
  });

describe('a red integration test is rerun, and only the red one (ISS-1120)', () => {
  it('names a red the base holds too base-red, and the gate does not refuse it', () => {
    const w = world();
    const f = fakeExec({ head: 'fail', base: 'fail' });
    const { reruns } = reran(w, f.exec);
    expect(reruns).toEqual([
      expect.objectContaining({ check: w.check.id, file: RED, verdict: 'base-red' }),
    ]);
    expect(reruns[0].runs.map((r) => [r.at, r.sha, r.result])).toEqual([
      ['head', HEAD, 'fail'],
      ['base', BASE, 'fail'],
    ]);
    expect(redChecks([w.check], reruns)).toEqual([]);
    // only the red file ran again, never the selection
    const tests = f.ran.filter((r) => r.argv.includes('vitest'));
    expect(tests).toHaveLength(2);
    expect(tests.every((r) => r.argv.some((a) => a.endsWith(RED)))).toBe(true);
    expect(reruns[0].runs.map((r) => r.failed)).toEqual([[ONE], [ONE]]);
  });

  it('refuses a file red at the base for another test as the change’s own red', () => {
    const w = world();
    const f = fakeExec({ head: 'fail', base: 'fail', headFailed: [ONE, TWO], baseFailed: [ONE] });
    const { reruns } = reran(w, f.exec);
    expect(reruns.map((x) => x.verdict)).toEqual(['branch-red']);
    expect(redChecks([w.check], reruns)).toEqual([w.check]);
  });

  it('reads a suite that did not load as base-red only beside a base failing the same way', () => {
    const w = world();
    const both = reran(
      w,
      fakeExec({ head: 'fail', base: 'fail', headFailed: [], baseFailed: [] }).exec,
    );
    expect(both.reruns.map((x) => x.verdict)).toEqual(['base-red']);
    const headOnly = reran(w, fakeExec({ head: 'fail', base: 'fail', headFailed: [] }).exec);
    expect(headOnly.reruns.map((x) => x.verdict)).toEqual(['branch-red']);
  });

  it('refuses a red whose rerun wrote no report, since nothing shows the base holds it', () => {
    const w = world();
    const { reruns } = reran(w, fakeExec({ head: 'fail', base: 'fail', baseFailed: null }).exec);
    expect(reruns[0].runs[1]).not.toHaveProperty('failed');
    expect(reruns.map((x) => x.verdict)).toEqual(['branch-red']);
  });

  it('makes the base worktree detached under the repository’s .claude/worktrees and removes it after', () => {
    const w = world();
    const f = fakeExec({ head: 'fail', base: 'fail' });
    reran(w, f.exec);
    const add = f.ran.find((r) => r.argv[2] === 'add');
    const remove = f.ran.find((r) => r.argv[2] === 'remove');
    expect(add?.argv.slice(0, 4)).toEqual(['git', 'worktree', 'add', '--detach']);
    expect(add?.argv[4]).toContain(join(w.root, '.claude', 'worktrees', 'merge-check-base-'));
    expect(add?.argv[5]).toBe(BASE);
    expect(remove?.argv.slice(0, 4)).toEqual(['git', 'worktree', 'remove', '--force']);
    expect(remove?.argv[4]).toBe(add?.argv[4]);
  });

  it('names a red that went green on its rerun at the head flaky, never reaching the base', () => {
    const w = world();
    const f = fakeExec({ head: 'pass', base: 'fail' });
    const { reruns } = reran(w, f.exec);
    expect(reruns.map((x) => x.verdict)).toEqual(['flaky']);
    expect(f.ran.some((r) => r.argv[2] === 'add')).toBe(false);
    expect(redChecks([w.check], reruns)).toEqual([]);
  });

  it('refuses a red green at the merge base as the change’s own, as before', () => {
    const w = world();
    const { reruns } = reran(w, fakeExec({ head: 'fail', base: 'pass' }).exec);
    expect(reruns.map((x) => x.verdict)).toEqual(['branch-red']);
    expect(redChecks([w.check], reruns)).toEqual([w.check]);
  });

  it('refuses a red file the base does not hold, and one whose base could not be installed, naming why', () => {
    const w = world();
    const absent = reran(w, fakeExec({ head: 'fail', base: 'fail', baseHolds: false }).exec);
    expect(absent.reruns[0].runs[1]).toMatchObject({ at: 'base', result: 'absent' });
    expect(absent.reruns[0].verdict).toBe('branch-red');
    const f = fakeExec({ head: 'fail', base: 'fail', install: false });
    const broken = reran(w, f.exec);
    expect(broken.reruns[0].runs[1]).toMatchObject({
      result: 'error',
      note: expect.stringContaining('pnpm install'),
    });
    expect(broken.reruns[0].verdict).toBe('branch-red');
    expect(f.ran.some((r) => r.argv[2] === 'remove')).toBe(true);
  });

  it('leaves a red whose run named no red file the change’s, saying so', () => {
    const w = world({ json: false });
    const { reruns, unclassed } = reran(w, fakeExec({ head: 'pass', base: 'fail' }).exec);
    expect(reruns).toEqual([]);
    expect(unclassed[0]).toContain('wrote no JSON report');
    expect(redChecks([w.check], reruns)).toEqual([w.check]);
  });

  it('reruns no check but a red integration run', () => {
    const w = world();
    const direct = { ...w.check, name: 'direct-tests' };
    const f = fakeExec({ head: 'pass', base: 'pass' });
    expect(
      rerunReds({
        root: w.root,
        commonGitDir: join(w.root, '.git'),
        head: HEAD,
        base: BASE,
        checks: [direct],
        calls: w.calls,
        exec: f.exec,
        rebuild,
      }).reruns,
    ).toEqual([]);
    expect(f.ran).toEqual([]);
  });
});

describe('what the reruns read and write', () => {
  it('has every vitest run write its JSON report, and records the files it was handed', () => {
    const seen = [];
    const { exec, calls, dispose } = recordingExec((argv) => {
      seen.push(argv);
      return { ok: true };
    }, '/r');
    exec(['pnpm', 'exec', 'vitest', 'run', '--config', 'c.ts', `/r/${RED}`], '/r/packages/core');
    exec(['pnpm', '--filter', 'x', 'run', 'build'], '/r');
    expect(seen[0]).toContain('--reporter=json');
    expect(seen[0].find((a) => a.startsWith('--outputFile.json='))).toBe(
      `--outputFile.json=${calls[0].json}`,
    );
    expect(seen[1]).toEqual(['pnpm', '--filter', 'x', 'run', 'build']);
    expect(calls).toEqual([{ cwd: '/r/packages/core', files: [RED], json: calls[0].json }]);
    dispose();
    expect(existsSync(dirname(calls[0].json))).toBe(false);
  });

  it('reads the red files of a vitest JSON report, and refuses one it cannot read by name', () => {
    expect(
      redFilesOf(JSON.stringify({ testResults: [{ name: `/r/${RED}`, status: 'failed' }] }), '/r'),
    ).toEqual({ files: [RED] });
    expect(redFilesOf('nope', '/r').refusal).toContain('not JSON');
    expect(redFilesOf('{}', '/r').refusal).toContain('no testResults');
  });

  it('bears the verdict the contract holds a report to, for every outcome alike', () => {
    const lists = [undefined, [], [ONE], [TWO], [ONE, TWO]];
    const outcomes = RERUN_RESULTS.flatMap((result) => lists.map((failed) => ({ result, failed })));
    for (const head of outcomes)
      for (const base of [null, ...outcomes])
        expect(rerunVerdictOf(head, base), JSON.stringify({ head, base })).toBe(
          contractVerdictOf(head, base),
        );
    expect(rerunVerdictOf({ result: 'pass' }, null)).toBe('flaky');
    expect(
      rerunVerdictOf({ result: 'fail', failed: [ONE] }, { result: 'fail', failed: [ONE, TWO] }),
    ).toBe('base-red');
    expect(
      rerunVerdictOf({ result: 'fail', failed: [TWO] }, { result: 'fail', failed: [ONE] }),
    ).toBe('branch-red');
    expect(rerunVerdictOf({ result: 'fail', failed: [ONE] }, { result: 'pass' })).toBe(
      'branch-red',
    );
  });

  it('sends the reruns in the report, and lists base-red and flaky apart from the change’s reds', () => {
    const w = world();
    const { reruns } = reran(w, fakeExec({ head: 'fail', base: 'fail' }).exec);
    const body = reportOf({
      branch: 'dev',
      baseSha: BASE,
      head: HEAD,
      mode: 'pre-merge',
      touched: [],
      checks: [w.check],
      reruns,
      patchId: '7'.repeat(40),
    });
    expect(body.reruns).toEqual(reruns);
    expect(
      'reruns' in
        reportOf({
          branch: 'dev',
          baseSha: BASE,
          head: HEAD,
          mode: 'pre-merge',
          touched: [],
          checks: [],
          patchId: 'p',
        }),
    ).toBe(false);
    expect(rerunLines(reruns)[0]).toMatch(
      /^ {2}base-red {2}.*slow-reads-at-scale.*head a{12} fail, base b{12} fail/,
    );
  });

  it('puts the base worktree inside the repository, by its common git dir', () => {
    expect(baseWorktreePath('/repo/.git', BASE, 7)).toBe(
      `/repo/.claude/worktrees/merge-check-base-${BASE.slice(0, 12)}-7`,
    );
  });
});
