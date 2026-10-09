// @direct-test-of .github/workflows/ci.yml
// The whole suite's rules (lib/whole-suite.mjs) and its shape in .github/workflows/ci.yml: which
// jobs run, and which event reaches it. The aggregate step's shell runs in
// whole-suite-cli.test.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bisect,
  bisectReport,
  brokenJobs,
  evidenceOf,
  failedOnATest,
  failingJobs,
  fanoutTargets,
  gateVerdict,
  issuesOf,
  lastGreen,
  SUITE_REPORTERS,
  suiteState,
  unjudgedJobs,
} from './whole-suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
const WHOLE = "github.event_name == 'schedule' || inputs.suite == 'whole'";
const UNJUDGED = unjudgedJobs(CI);

const check = (name, status, conclusion, id = 1, runId = 900, slug = 'github-actions') => ({
  id,
  name,
  status,
  conclusion,
  app: { slug },
  html_url: `https://github.com/o/r/actions/runs/${runId}/job/${id}`,
});

function reader({ checkRuns = {}, runs = {}, jobs = {} } = {}) {
  return {
    checkRuns: (sha) => checkRuns[sha] ?? [],
    runs: (sha) => runs[sha] ?? [],
    jobs: (id) => jobs[id] ?? [],
  };
}

const stateOf = (plan) => suiteState(reader(plan), 'a', UNJUDGED).state;

/** One top-level job's block of ci.yml, up to the next job. */
function job(name) {
  const at = CI.indexOf(`\n  ${name}:\n`);
  expect(at, `ci.yml has no job ${name}`).toBeGreaterThan(-1);
  const rest = CI.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const ifOf = (name) => /^ {4}if: (.*)$/m.exec(job(name))?.[1] ?? null;
const needsOf = (name) =>
  /needs:\s*\[([^\]]*)\]/
    .exec(job(name))[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const jobNames = () =>
  [...CI.slice(CI.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]);

describe('where the whole suite stands on a commit', () => {
  it('green, red with its failing jobs, running, and none are four answers', () => {
    expect(stateOf({ checkRuns: { a: [check('whole-suite', 'completed', 'success')] } })).toBe(
      'green',
    );

    const jobs = [
      { name: 'core', conclusion: 'failure' },
      { name: 'docs', conclusion: 'skipped' },
      { name: 'web', conclusion: 'success' },
      { name: 'whole-suite', conclusion: 'failure' },
      { name: 'merge-check', conclusion: 'skipped' },
    ];
    const checkRuns = { a: [check('whole-suite', 'completed', 'failure', 2, 77)] };
    const red = suiteState(reader({ checkRuns, jobs: { 77: jobs } }), 'a', UNJUDGED);
    expect(red).toMatchObject({ state: 'red', failing: ['core (failure)', 'docs (skipped)'] });

    expect(stateOf({ checkRuns: { a: [check('whole-suite', 'in_progress', null)] } })).toBe(
      'running',
    );
    const queued = { id: 3, event: 'schedule', status: 'queued', html_url: 'u' };
    expect(stateOf({ runs: { a: [queued] } })).toBe('running');
    const pushed = { id: 3, event: 'push', status: 'in_progress' };
    expect(stateOf({ runs: { a: [pushed] } })).toBe('none');
    expect(stateOf({})).toBe('none');
  });

  it('the newest whole-suite check decides, and one another app named whole-suite is not read', () => {
    const older = check('whole-suite', 'completed', 'failure', 1);
    const newer = check('whole-suite', 'completed', 'success', 2);
    expect(stateOf({ checkRuns: { a: [newer, older] } })).toBe('green');
    const foreign = check('whole-suite', 'completed', 'success', 9, 900, 'some-app');
    expect(stateOf({ checkRuns: { a: [foreign] } })).toBe('none');
  });

  it('the reporters are not counted as the suite', () => {
    const reporters = SUITE_REPORTERS.map((name) => ({ name, conclusion: 'failure' }));
    expect(failingJobs(reporters, UNJUDGED)).toEqual([]);
  });
});

describe('a job a whole-suite run does not judge is no reason it went red, and nothing to bisect', () => {
  // Run 37949879909 on 00176acd7, as GitHub recorded it: the Windows leg failed, and merge-check,
  // dev's merge path, was skipped by design, as in every whole-suite run since ISS-472.
  const jobs = [
    { name: 'changes', conclusion: 'success' },
    { name: 'nightly-fanout', conclusion: 'skipped' },
    { name: 'core', conclusion: 'success' },
    { name: 'runner-platforms (windows-latest)', conclusion: 'failure' },
    { name: 'runner-platforms (macos-latest)', conclusion: 'success' },
    { name: 'merge-check', conclusion: 'skipped' },
    { name: 'ci-passed', conclusion: 'success' },
    { name: 'whole-suite', conclusion: 'failure' },
    { name: 'suite-bisect', conclusion: 'success' },
  ];

  it('the jobs not judged are read from ci.yml: every job the whole-suite job does not need', () => {
    expect([...UNJUDGED].sort()).toEqual([...SUITE_REPORTERS, 'merge-check'].sort());
    expect(unjudgedJobs('jobs:\n  a:\n    runs-on: x\n')).toBe(null);
    expect(unjudgedJobs('name: CI\n')).toBe(null);
  });

  it('merge-check, skipped, is neither a reason nor bisected; the failed leg is both', () => {
    expect(failingJobs(jobs, UNJUDGED)).toEqual(['runner-platforms (windows-latest) (failure)']);
    expect(brokenJobs(jobs, UNJUDGED)).toEqual(['runner-platforms (windows-latest)']);
  });

  it('a judged job that was skipped or cancelled is a reason the suite went red, but not bisected', () => {
    const more = [
      ...jobs,
      { name: 'web', conclusion: 'skipped' },
      { name: 'docs', conclusion: 'cancelled' },
      { name: 'core-integration', conclusion: 'timed_out' },
    ];
    expect(failingJobs(more, UNJUDGED)).toEqual([
      'runner-platforms (windows-latest) (failure)',
      'web (skipped)',
      'docs (cancelled)',
      'core-integration (timed_out)',
    ]);
    expect(brokenJobs(more, UNJUDGED)).toEqual([
      'runner-platforms (windows-latest)',
      'core-integration',
    ]);
  });

  it('a red run no job of which failed on its own steps names no merge, and says rerun', () => {
    const report = bisectReport({
      red: '00176acd78c7',
      failing: ['runner-platforms (macos-latest) (cancelled)'],
      green: null,
      result: null,
      searched: 0,
      runId: 37949879909,
    });
    expect(report).toContain('No job failed on its own steps, so no merge is named');
    expect(report).toContain('gh run rerun 37949879909 --failed');
    expect(report).not.toContain('The merge that broke it');
  });
});

describe('a whole-suite check concluded skipped is no record', () => {
  // Every run that is not a whole-suite run (a push, a pull request, a dispatch without
  // suite: whole) skips the whole-suite job, and GitHub records that as a completed check run
  // concluded `skipped` on the commit (main ebbf3c813, runs 37860396822 and 37854612040).
  const skipped = (id = 5) => check('whole-suite', 'completed', 'skipped', id, 950);

  it('the gate reads a commit carrying only a skipped one as having no run, so the cut starts one', () => {
    const s = suiteState(reader({ checkRuns: { a: [skipped()] } }), 'a', UNJUDGED);
    expect(s.state).toBe('none');
    expect(gateVerdict(s).dispatch).toBe(true);
  });

  it('a newer skipped one neither hides an older green nor an older red', () => {
    const green = check('whole-suite', 'completed', 'success', 1);
    expect(stateOf({ checkRuns: { a: [skipped(9), green] } })).toBe('green');
    const red = check('whole-suite', 'completed', 'failure', 1, 77);
    const jobs = { 77: [{ name: 'core', conclusion: 'failure' }] };
    expect(stateOf({ checkRuns: { a: [skipped(9), red] }, jobs })).toBe('red');
  });

  it('a run in flight beside a skipped one still reads running, and starts nothing', () => {
    const queued = { id: 3, event: 'workflow_dispatch', status: 'queued', html_url: 'u' };
    expect(stateOf({ checkRuns: { a: [skipped()] }, runs: { a: [queued] } })).toBe('running');
  });

  it('the bisect reads past it to the failing jobs own checks', () => {
    expect(evidenceOf([skipped()], ['core'])).toBe(null);
    expect(evidenceOf([skipped(), check('core', 'completed', 'success', 2)], ['core'])).toBe(
      'good',
    );
    expect(evidenceOf([skipped(), check('core', 'completed', 'failure', 2)], ['core'])).toBe('bad');
  });

  it('it is never the last green', () => {
    const history = { landings: ['r', 'b'], ancestors: ['b'], holds: (x, y) => x === y };
    expect(lastGreen(reader({ checkRuns: { b: [skipped()] } }), history)).toBe(null);
  });
});

describe('a cut on a commit (RELEASE_SUITE_NOT_GREEN)', () => {
  const sha = 'abcdef0123456789';

  it('only a green run lets it proceed', () => {
    expect(gateVerdict({ state: 'green', sha, url: 'u' }).ok).toBe(true);
    for (const state of ['red', 'running', 'none']) {
      const v = gateVerdict({ state, sha, url: 'u', failing: ['core (failure)'] });
      expect(v.ok).toBe(false);
      expect(v.sentence.startsWith('RELEASE_SUITE_NOT_GREEN: ')).toBe(true);
    }
  });

  it('a red run no job of which failed on its own steps says rerun, never "land the fix"', () => {
    const red = { state: 'red', sha, url: 'u', runId: 9, checkId: 1 };
    const cancelled = gateVerdict({ ...red, failing: ['x (cancelled)'], onATest: false });
    expect(cancelled.rerun).toBe(9);
    expect(cancelled.sentence).toContain('A rerun settles it, not a fix: gh run rerun 9 --failed');
    expect(cancelled.sentence).not.toContain('Land the fix');
    const failed = gateVerdict({ ...red, failing: ['core (failure)'], onATest: true });
    expect(failed.rerun).toBeUndefined();
    expect(failed.sentence).toContain('Land the fix');
  });

  it('a failure or a timeout is a failure on its own steps; cancelled, skipped and the reporters are not', () => {
    expect(failedOnATest([{ name: 'core', conclusion: 'failure' }], UNJUDGED)).toBe(true);
    expect(failedOnATest([{ name: 'web', conclusion: 'timed_out' }], UNJUDGED)).toBe(true);
    const none = ['cancelled', 'skipped', 'startup_failure', 'success'];
    expect(
      failedOnATest(
        none.map((conclusion) => ({ name: 'core', conclusion })),
        UNJUDGED,
      ),
    ).toBe(false);
    expect(failedOnATest([{ name: 'whole-suite', conclusion: 'failure' }], UNJUDGED)).toBe(false);
  });

  it('a rerun of a red run in flight reads running, so the cut waits on it', () => {
    const red = check('whole-suite', 'completed', 'failure', 2, 77);
    const rerun = { id: 77, event: 'workflow_dispatch', status: 'in_progress', html_url: 'u' };
    expect(stateOf({ checkRuns: { a: [red] }, runs: { a: [rerun] } })).toBe('running');
  });

  it('only a commit with no run and none in flight starts one', () => {
    expect(gateVerdict({ state: 'none', sha }).dispatch).toBe(true);
    expect(gateVerdict({ state: 'running', sha, url: 'u' }).dispatch).toBe(false);
    expect(gateVerdict({ state: 'red', sha, url: 'u', failing: [] }).dispatch).toBe(false);
  });
});

describe('bisecting a red run by what CI recorded', () => {
  const L = (sha) => ({ sha, subject: `land ${sha}`, issues: [] });
  const marks = (m) => (sha) => m[sha] ?? null;

  it('one landing between the last good record and the first bad one is named', () => {
    expect(bisect([L('a'), L('b'), L('c')], marks({ a: 'good', b: 'bad' }))).toEqual({
      named: L('b'),
    });
  });

  it('the red commit itself is named when everything before it recorded good', () => {
    expect(bisect([L('a'), L('b')], marks({ a: 'good' }))).toEqual({ named: L('b') });
  });

  it('a failure fixed before the last good record is not this red', () => {
    expect(bisect([L('a'), L('b'), L('c')], marks({ a: 'bad', b: 'good' }))).toEqual({
      named: L('c'),
    });
  });

  it('landings no record separates are the range, every one of them', () => {
    expect(bisect([L('a'), L('b'), L('c')], marks({}))).toEqual({
      range: [L('a'), L('b'), L('c')],
    });
    expect(bisect([L('a'), L('b'), L('c'), L('d')], marks({ a: 'good' }))).toEqual({
      range: [L('b'), L('c'), L('d')],
    });
  });

  it('a green whole-suite run is good; a red one is read by its jobs, and only the failing jobs are read otherwise', () => {
    const both = ['core', 'web'];
    const red = check('whole-suite', 'completed', 'failure', 5);
    expect(evidenceOf([check('whole-suite', 'completed', 'success')], ['core'])).toBe('good');
    expect(evidenceOf([red, check('core', 'completed', 'failure', 6)], ['core'])).toBe('bad');
    // Red there for a cancelled macOS leg: core passed on it, so it is good for core's red now.
    const cancelled = check('runner-platforms (macos-latest)', 'completed', 'cancelled', 7);
    expect(evidenceOf([red, cancelled, check('core', 'completed', 'success', 6)], ['core'])).toBe(
      'good',
    );
    expect(evidenceOf([red], ['core'])).toBe(null);
    expect(evidenceOf([check('core', 'completed', 'failure')], both)).toBe('bad');
    expect(evidenceOf([check('core', 'completed', 'success')], both)).toBe(null);
    const passed = [check('core', 'completed', 'success'), check('web', 'completed', 'success', 2)];
    expect(evidenceOf(passed, both)).toBe('good');
    expect(evidenceOf([check('scoped-check', 'completed', 'success')], ['core'])).toBe(null);
    expect(evidenceOf([check('core', 'completed', 'skipped')], ['core'])).toBe(null);
  });

  /** A graph by each commit's parents; `holds(a, b)` walks every parent, as git does. */
  const graph = (parents) => {
    const holds = (a, b) => a === b || (parents[a] ?? []).some((p) => holds(p, b));
    return holds;
  };

  it('on a straight line, the last green is the newest landing carrying one', () => {
    const r = reader({
      checkRuns: {
        c: [check('core', 'completed', 'success')],
        b: [check('whole-suite', 'completed', 'success')],
        a: [check('whole-suite', 'completed', 'success')],
      },
    });
    const holds = graph({ r: ['c'], c: ['b'], b: ['a'] });
    const history = { landings: ['r', 'c', 'b', 'a'], ancestors: ['c', 'b', 'a'], holds };
    expect(lastGreen(r, history)).toEqual({ green: 'b', index: 2 });
    expect(lastGreen(reader(), history)).toBe(null);
  });

  // dev's graph around 00176acd7 (run 37949879909): the agent merged origin/previews-core (6599553c8,
  // the breaking merge) onto its own line, then merged origin/dev (0f5c17610), whose second parent
  // 6885f4552 carries a green whole-suite run and fixed the Windows leg dd16bbfe7 had broken. The
  // first-parent line meets only the older green on 176fbddaa. Abridged: c25ca259b's second
  // parent, and the landings between ed76e3cce and dd16bbfe7, are left out.
  const live = {
    '00176acd7': ['b8b710fa7', '0e697e0dc'],
    b8b710fa7: ['b38f83899'],
    b38f83899: ['0f5c17610', 'afe9b4d77'],
    '0f5c17610': ['6599553c8', '6885f4552'],
    '6599553c8': ['8ba9b17e3', '8efc65766'],
    '8efc65766': ['ae7a74d6b'],
    ae7a74d6b: ['dd16bbfe7'],
    '0e697e0dc': ['0f5c17610', '3885c1663'],
    '3885c1663': ['6885f4552'],
    '6885f4552': ['ad95727a4'],
    ad95727a4: ['8ba9b17e3'],
    afe9b4d77: ['ed76e3cce'],
    '8ba9b17e3': ['c25ca259b'],
    c25ca259b: ['ed76e3cce'],
    ed76e3cce: ['dd16bbfe7'],
    dd16bbfe7: ['176fbddaa'],
  };
  const liveHistory = {
    landings: [
      '00176acd7',
      'b8b710fa7',
      'b38f83899',
      '0f5c17610',
      '6599553c8',
      '8ba9b17e3',
      'c25ca259b',
      'ed76e3cce',
      'dd16bbfe7',
      '176fbddaa',
    ],
    ancestors: [
      'b8b710fa7',
      '0e697e0dc',
      '3885c1663',
      'b38f83899',
      'afe9b4d77',
      '0f5c17610',
      '6885f4552',
      'ad95727a4',
      '6599553c8',
      '8efc65766',
      'ae7a74d6b',
      '8ba9b17e3',
      'c25ca259b',
      'ed76e3cce',
      'dd16bbfe7',
      '176fbddaa',
    ],
    holds: graph(live),
  };

  it('a green reached through the second parent of a merge of origin/dev is the last green, and what it holds is no suspect', () => {
    const r = reader({
      checkRuns: {
        '6885f4552': [check('whole-suite', 'completed', 'success', 1, 37946526345)],
        dd16bbfe7: [check('whole-suite', 'completed', 'failure', 2, 37939100373)],
        '176fbddaa': [check('whole-suite', 'completed', 'success', 3, 37892678039)],
      },
    });
    const found = lastGreen(r, liveHistory);
    expect(found).toEqual({ green: '6885f4552', index: 5 });
    expect(liveHistory.landings.slice(0, found.index)).toContain('6599553c8');
    expect(liveHistory.landings.slice(0, found.index)).not.toContain('dd16bbfe7');
  });

  it('a green on a side line that holds no newer landing does not move the start', () => {
    const r = reader({
      checkRuns: {
        afe9b4d77: [check('whole-suite', 'completed', 'success', 1)],
        '6885f4552': [check('whole-suite', 'completed', 'success', 2)],
      },
    });
    // afe9b4d77 holds ed76e3cce (index 7); 6885f4552 holds 8ba9b17e3 (index 5), the newer one.
    expect(lastGreen(r, liveHistory)).toEqual({ green: '6885f4552', index: 5 });
  });

  it('a landing names its issues from its subject, its branch, or what it merged in', () => {
    expect(issuesOf('ISS-459 round 2: an open revision follows')).toEqual(['ISS-459']);
    expect(issuesOf("Merge branch 'iss-471' into dev")).toEqual(['ISS-471']);
    const merged = ['ISS-3: a', 'fix', 'ISS-4: b', 'ISS-3: c'];
    expect(issuesOf("Merge branch 'chat-net' into dev", merged)).toEqual(['ISS-3', 'ISS-4']);
    expect(issuesOf('Release dev-v0.4.0-dev.167')).toEqual([]);
  });
});

describe('ci.yml runs the whole suite on a schedule or a whole dispatch, and nowhere else', () => {
  it('the aggregate needs every job of the workflow but the reporters and the merge check', () => {
    // `merge-check` runs only on a push to dev or a pull request into dev (ISS-472): it is the merge
    // path, never part of a whole suite, and a skipped need would turn every whole-suite run red.
    const expected = jobNames().filter((j) => !SUITE_REPORTERS.includes(j) && j !== 'merge-check');
    expect(needsOf('whole-suite').sort()).toEqual(expected.sort());
  });

  it('the aggregate, the bisect and the fan-out are reached by no push and no pull request (BC-17)', () => {
    expect(ifOf('whole-suite')).toBe(`always() && (${WHOLE})`);
    expect(ifOf('suite-bisect')).toBe(
      `always() && (${WHOLE}) && needs.whole-suite.result == 'failure'`,
    );
    expect(ifOf('nightly-fanout')).toBe("github.event_name == 'schedule'");
    expect(needsOf('ci-passed')).not.toContain('whole-suite');
  });

  it('every job the change filter selects runs in a whole-suite run, which consults no filter', () => {
    for (const name of ['web', 'core', 'runner', 'docs']) {
      expect(ifOf(name)).toContain(`|| ${WHOLE}`);
    }
    expect(job('changes')).toContain(
      "if: github.event_name != 'schedule' && inputs.suite != 'whole'",
    );
    const afterMerge =
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
    for (const name of ['core-integration', 'runner-platforms']) {
      expect(ifOf(name)).toContain(afterMerge);
    }
    // `scoped` is false on a schedule and a dispatch; it is true only on dev's merge path (ISS-472).
    for (const name of ['images', 'whole-tree']) {
      expect(ifOf(name)).toBe(
        "needs.changes.outputs.scoped != 'true' && github.event_name != 'pull_request'",
      );
    }
  });

  it('the dispatch takes suite: whole, and changed is its default', () => {
    expect(CI).toMatch(
      / {6}suite:\n(?: {8}.*\n)*? {8}options: \[changed, whole\]\n {8}default: changed\n/,
    );
  });

  it('the fan-out reads the gated branches from the push trigger', () => {
    expect(fanoutTargets(CI, 'main')).toEqual(['dev']);
    expect(fanoutTargets(CI, 'dev')).toEqual(['main']);
    expect(fanoutTargets('jobs:\n', 'main')).toBe(null);
  });
});
