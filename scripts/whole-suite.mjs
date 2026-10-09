#!/usr/bin/env node

/**
 * The whole suite's three acts, each over what GitHub recorded (REQ-36 BC-10, BC-11):
 *
 *   gate    --commit <sha> --branch <b> [--dispatch]   may a release be cut on this commit?
 *   bisect  --commit <sha> [--run <id>]                which merge turned this whole-suite run red?
 *   fanout  --ran-on <branch>                          start the whole suite on every other gated branch
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
  'usage: whole-suite.mjs gate --commit <sha> --branch <b> [--dispatch] | bisect --commit <sha> [--run <id>] | fanout --ran-on <branch>';

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

function gate({ commit, branch, dispatch }) {
  if (!commit || !branch) cannot(`gate needs --commit and --branch\n${USAGE}`);
  const sha = git(['rev-parse', '--verify', `${commit}^{commit}`]);
  const reader = ghReader(repository());
  const verdict = gateVerdict(suiteState(reader, sha));
  if (verdict.ok) {
    console.log(verdict.sentence);
    return 0;
  }
  const lines = [verdict.sentence];
  if (verdict.dispatch && dispatch) {
    try {
      reader.dispatch(branch);
      lines.push(
        `Started the whole suite on ${branch} (its head is ${sha.slice(0, 9)}); it takes about 15 minutes. Cut again once it is green.`,
      );
    } catch (e) {
      lines.push(`Could not start it (${e.message}). Start it with: ${dispatchCommand(branch)}`);
    }
  } else if (verdict.dispatch) {
    lines.push(`Start it with: ${dispatchCommand(branch)}, then cut again once it is green.`);
  }
  console.error(lines.join('\n'));
  return 1;
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
