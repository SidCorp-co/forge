// The whole suite's rules (lib/whole-suite.mjs) and its shape in .github/workflows/ci.yml: which
// jobs run, and which event reaches it. The aggregate step's shell runs in
// whole-suite-cli.test.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bisect,
  evidenceOf,
  failedOnATest,
  failingJobs,
  fanoutTargets,
  gateVerdict,
  issuesOf,
  lastGreen,
  SUITE_REPORTERS,
  suiteState,
} from './whole-suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
const WHOLE = "github.event_name == 'schedule' || inputs.suite == 'whole'";

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

const stateOf = (plan) => suiteState(reader(plan), 'a').state;

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
    ];
    const checkRuns = { a: [check('whole-suite', 'completed', 'failure', 2, 77)] };
    const red = suiteState(reader({ checkRuns, jobs: { 77: jobs } }), 'a');
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
    expect(failingJobs(reporters)).toEqual([]);
  });
});

describe('a whole-suite check concluded skipped is no record', () => {
  // Every run that is not a whole-suite run (a push, a pull request, a dispatch without
  // suite: whole) skips the whole-suite job, and GitHub records that as a completed check run
  // concluded `skipped` on the commit (main ebbf3c813, runs 37860396822 and 37854612040).
  const skipped = (id = 5) => check('whole-suite', 'completed', 'skipped', id, 950);

  it('the gate reads a commit carrying only a skipped one as having no run, so the cut starts one', () => {
    const s = suiteState(reader({ checkRuns: { a: [skipped()] } }), 'a');
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
    expect(lastGreen(reader({ checkRuns: { b: [skipped()] } }), ['b'])).toBe(null);
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
    expect(failedOnATest([{ name: 'core', conclusion: 'failure' }])).toBe(true);
    expect(failedOnATest([{ name: 'web', conclusion: 'timed_out' }])).toBe(true);
    const none = ['cancelled', 'skipped', 'startup_failure', 'success'];
    expect(failedOnATest(none.map((conclusion) => ({ name: 'core', conclusion })))).toBe(false);
    expect(failedOnATest([{ name: 'whole-suite', conclusion: 'failure' }])).toBe(false);
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

  it('the last green whole-suite run is the newest ancestor carrying one', () => {
    const r = reader({
      checkRuns: {
        c: [check('core', 'completed', 'success')],
        b: [check('whole-suite', 'completed', 'success')],
        a: [check('whole-suite', 'completed', 'success')],
      },
    });
    expect(lastGreen(r, ['c', 'b', 'a'])).toBe('b');
    expect(lastGreen(reader(), ['c', 'b'])).toBe(null);
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
  it('the aggregate needs every job of the workflow but the reporters', () => {
    const expected = jobNames().filter((j) => !SUITE_REPORTERS.includes(j));
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
    for (const name of ['images', 'whole-tree']) {
      expect(ifOf(name)).toBe("github.event_name != 'pull_request'");
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
