#!/usr/bin/env node

/**
 * The whole suite's three acts, each over what GitHub recorded (REQ-36 BC-10, BC-11):
 *
 *   gate    --commit <sha> --branch <b> [--dispatch [--wait <min> --poll <s>]]   may a release be cut on this commit?
 *   bisect  --commit <sha> [--run <id>]          which merge turned this whole-suite run red?
 *   fanout  --ran-on <branch>                    start the whole suite on every other gated branch
 *
 * The repository is `GITHUB_REPOSITORY`, else the one `origin` names. GitHub is reached through
 * `gh api`, under whatever credential `gh` holds (`GH_TOKEN` in CI). Exit 0 is the answer, 1 a
 * refusal or a failed dispatch, 2 a read that could not be taken: a gate that could not read is
 * never a pass. The rules themselves: `lib/whole-suite.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { ROOT } from './lib/gate.mjs';
import {
  bisect,
  bisectReport,
  dispatchCommand,
  evidenceOf,
  failingJobs,
  fanoutTargets,
  gateVerdict,
  HISTORY_LIMIT,
  issuesOf,
  lastGreen,
  SUITE_REPORTERS,
  suiteState,
} from './lib/whole-suite.mjs';

const USAGE =
  'usage: whole-suite.mjs gate --commit <sha> --branch <b> [--dispatch [--wait <minutes> --poll <seconds>]] | bisect --commit <sha> [--run <id>] | fanout --ran-on <branch>';

class CannotRead extends Error {}

function cannot(message) {
  console.error(`whole-suite: ${message}`);
  process.exit(2);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) cannot(`unexpected argument \`${a}\`\n${USAGE}`);
    const key = a.slice(2);
    if (key === 'dispatch') out.dispatch = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) cannot(`--${key} needs a value`);
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function git(args) {
  const r = run('git', args);
  if (r.status !== 0) throw new CannotRead(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m)
    throw new CannotRead(
      `cannot tell which GitHub repository origin is (${url}); set GITHUB_REPOSITORY`,
    );
  return m[1];
}

/** GitHub, through `gh api`. Every read that fails throws: a gate never reads a failure as none. */
function ghReader(repo) {
  const api = (args) => {
    const r = run('gh', ['api', ...args]);
    if (r.error) throw new CannotRead(`gh could not be run: ${r.error.message}`);
    if (r.status !== 0)
      throw new CannotRead(`gh api ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const cache = new Map();
  return {
    /** Forget what was read, so a gate waiting on a run reads it again. */
    fresh() {
      cache.clear();
    },
    rerun(runId) {
      api(['-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
    },
    checkRuns(sha) {
      if (!cache.has(sha)) {
        cache.set(
          sha,
          api([`repos/${repo}/commits/${sha}/check-runs?per_page=100`]).check_runs ?? [],
        );
      }
      return cache.get(sha);
    },
    runs: (sha) =>
      api([`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`])
        .workflow_runs ?? [],
    jobs: (runId) =>
      api([`repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`]).jobs ?? [],
    dispatch(branch) {
      api([
        '-X',
        'POST',
        `repos/${repo}/actions/workflows/ci.yml/dispatches`,
        '-f',
        `ref=${branch}`,
        '-f',
        `inputs[base]=${branch}`,
        '-f',
        'inputs[suite]=whole',
      ]);
    },
  };
}

/** How long a run just asked for may take to show on the commit before the ask counts as lost. */
const SHOW_UP_MS = 3 * 60_000;

function count(value, flag, unit) {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) cannot(`--${flag} takes a number of ${unit}, not \`${value}\``);
  return n;
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * May a release be cut on this commit? Without `--dispatch` it reads and answers, and starts
 * nothing: that is a rehearsal. With `--dispatch` it acts so the cut can finish: it starts the
 * whole suite where the commit has none (only on the branch's head, since a dispatch runs there),
 * and reruns, once, a red run no job of which failed on its own steps. With `--wait <minutes>` it
 * then waits on that run, reading again every `--poll <seconds>`, and answers green or red rather
 * than "not yet": a cut that has to come back later finds a newer head with no run, every time,
 * on a branch that lands several commits an hour.
 */
function gate({ commit, branch, dispatch, wait, poll }) {
  if (!commit || !branch) cannot(`gate needs --commit and --branch\n${USAGE}`);
  const waitMs = count(wait, 'wait', 'minutes') * 60_000;
  const pollMs = count(poll, 'poll', 'seconds') * 1000;
  const sha = git(['rev-parse', '--verify', `${commit}^{commit}`]);
  const at = sha.slice(0, 9);
  const reader = ghReader(repository());
  const deadline = Date.now() + waitMs;
  const did = [];
  let asked = null;
  let reran = null;
  const refuse = (...lines) => {
    console.error([...lines, ...did].join('\n'));
    return 1;
  };
  for (;;) {
    reader.fresh();
    const status = suiteState(reader, sha);
    const verdict = gateVerdict(status);
    if (verdict.ok) {
      for (const line of did) console.log(line);
      console.log(verdict.sentence);
      return 0;
    }
    if (!dispatch) {
      const how = verdict.dispatch ? ` Start it with: ${dispatchCommand(branch)}.` : '';
      return refuse(verdict.sentence, `A rehearsal starts nothing.${how}`);
    }
    if (verdict.dispatch && asked === null) {
      const head = git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
      if (head !== sha) {
        return refuse(
          verdict.sentence,
          `${at} is no longer the head of ${branch} (${head.slice(0, 9)}), and a dispatch runs on the head, so nothing can start a whole-suite run on ${at}. Cut on the head.`,
        );
      }
      try {
        reader.dispatch(branch);
      } catch (e) {
        return refuse(
          verdict.sentence,
          `Could not start it (${e.message}). Start it with: ${dispatchCommand(branch)}`,
        );
      }
      asked = Date.now();
      did.push(
        `Started the whole suite on ${branch} (its head is ${at}); it takes about 15 minutes.`,
      );
    } else if (verdict.rerun && reran === null) {
      try {
        reader.rerun(verdict.rerun);
      } catch (e) {
        return refuse(verdict.sentence, `Could not rerun it (${e.message}).`);
      }
      reran = { at: Date.now(), checkId: status.checkId };
      did.push(`Reran the jobs of run ${verdict.rerun} that did not succeed.`);
    } else if (verdict.rerun && status.checkId !== reran.checkId) {
      return refuse(verdict.sentence, 'The rerun this cut asked for was red the same way again.');
    }
    // Waiting is owed only on a run that is running, or on one this cut just asked for.
    const owed =
      verdict.wait ||
      (verdict.dispatch && asked !== null) ||
      (verdict.rerun && reran?.checkId === status.checkId);
    if (!owed) return refuse(verdict.sentence);
    if (waitMs === 0) return refuse(verdict.sentence, 'Cut again once it has finished.');
    if (verdict.dispatch && Date.now() - asked >= SHOW_UP_MS) {
      return refuse(
        verdict.sentence,
        `The run started on ${branch} has not shown on ${at}: ${branch} moved before it started, so it ran on another commit. Cut on the head.`,
      );
    }
    if (verdict.rerun && Date.now() - reran.at >= SHOW_UP_MS) {
      return refuse(verdict.sentence, 'The rerun this cut asked for has not started.');
    }
    if (Date.now() >= deadline) {
      return refuse(
        verdict.sentence,
        `Not finished after ${waitMs / 60_000} minutes. Cut again with --at ${sha} to go on waiting on this commit's run rather than start one on a newer head.`,
      );
    }
    sleep(pollMs);
  }
}

/** One landing on the branch: a first-parent commit, its subject, and the issue it names. */
function landing(sha) {
  const subject = git(['log', '-1', '--format=%s', sha]);
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
  const merged =
    parents.length > 1
      ? git(['log', '--format=%s', `${parents[0]}..${parents[1]}`]).split('\n')
      : [];
  return { sha, subject, issues: issuesOf(subject, merged) };
}

function bisectRed({ commit, run: runArg }) {
  if (!commit) cannot(`bisect needs --commit\n${USAGE}`);
  const runId = runArg ?? process.env.GITHUB_RUN_ID;
  if (!runId) cannot('bisect needs --run, or GITHUB_RUN_ID, to read which jobs failed');
  const red = git(['rev-parse', '--verify', `${commit}^{commit}`]);
  const reader = ghReader(repository());
  const jobs = reader.jobs(runId);
  const failing = failingJobs(jobs);
  const failingNames = jobs
    .filter((j) => !SUITE_REPORTERS.includes(j.name) && j.conclusion !== 'success')
    .map((j) => j.name);
  const history = git([
    'rev-list',
    '--first-parent',
    `--max-count=${HISTORY_LIMIT + 1}`,
    red,
  ]).split('\n');
  const ancestors = history.slice(1);
  const green = lastGreen(reader, ancestors);
  const span = green === null ? history : history.slice(0, history.indexOf(green));
  const landings = span.reverse().map(landing);
  const result = bisect(landings, (sha) =>
    sha === red ? 'bad' : evidenceOf(reader.checkRuns(sha), failingNames),
  );
  const report = bisectReport({ red, failing, green, result, searched: ancestors.length });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Whole suite red\n\n${report}\n`);
  }
  const named = result.named
    ? `the merge that broke it is ${result.named.sha.slice(0, 9)} (${result.named.issues.join(', ') || 'names no issue'})`
    : `no single merge is named; ${result.range.length} are in range (see the job summary)`;
  console.log(`::error title=Whole suite red::${named}`);
  return 0;
}

function fanout({ 'ran-on': ranOn }) {
  if (!ranOn) cannot(`fanout needs --ran-on\n${USAGE}`);
  const targets = fanoutTargets(
    readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    ranOn,
  );
  if (targets === null) cannot('cannot read the gated branches from ci.yml on.push.branches');
  const reader = ghReader(repository());
  const failed = [];
  for (const branch of targets) {
    try {
      reader.dispatch(branch);
      console.log(`started the whole suite on ${branch}`);
    } catch (e) {
      failed.push(branch);
      console.error(`::error::could not start the whole suite on ${branch}: ${e.message}`);
    }
  }
  if (targets.length === 0) console.log(`no gated branch but ${ranOn}: nothing to start`);
  return failed.length > 0 ? 1 : 0;
}

const [act, ...rest] = process.argv.slice(2);
const acts = { gate, bisect: bisectRed, fanout };
if (!(act in acts)) cannot(USAGE);
try {
  process.exit(acts[act](flags(rest)));
} catch (e) {
  if (e instanceof CannotRead) cannot(e.message);
  throw e;
}
