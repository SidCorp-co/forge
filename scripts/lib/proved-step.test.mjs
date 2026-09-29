// @gate-input whole-tree — it runs ci.yml's own shell, which the root-walk guard cannot see into.
// The `proved` step in ci.yml decides whether a push skips `core`, `core-integration`, `web` and
// `runner`. Its shell runs here as written, under the flags GitHub gives `shell: bash`, in depth-1
// clones — the only runtime where a parent read can be falsified by the shallow graft (ISS-1340).
// `gh` is a stand-in that serves fixture check runs through the real `jq`; git is real throughout.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROVED_STEP } from './base-branch.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');
const REPO = 'SidCorp-co/forge';

/** The expressions a step may still carry, mapped to the variable GitHub sets beside each. */
const EXPRESSIONS = {
  'github.ref': 'GITHUB_REF',
  'github.event_name': 'GITHUB_EVENT_NAME',
  'github.repository': 'GITHUB_REPOSITORY',
};

/** The `run: |` body of the named step, dedented, with its `${{ }}` expressions as variables. */
function stepShell(yaml, name) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) throw new Error(`no step named "${name}" in ${WORKFLOW}`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  if (run === -1) throw new Error(`step "${name}" has no \`run: |\` block`);
  const keyIndent = lines[run].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const shell = body.map((l) => l.slice(indent)).join('\n');
  return shell.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (!(expr in EXPRESSIONS)) {
      throw new Error(`step "${name}" reads \`\${{ ${expr} }}\`, which this test cannot supply`);
    }
    return `\${${EXPRESSIONS[expr]}}`;
  });
}

let box;
const sha = {};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function gitEnv() {
  return {
    PATH: process.env.PATH ?? '',
    HOME: box,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'check',
    GIT_AUTHOR_EMAIL: 'check@example.invalid',
    GIT_COMMITTER_NAME: 'check',
    GIT_COMMITTER_EMAIL: 'check@example.invalid',
  };
}

function commit(seed, file, text, message) {
  writeFileSync(join(seed, file), text);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', message);
  return git(seed, 'rev-parse', 'HEAD');
}

/** Each scenario's HEAD is published as its own branch, so a depth-1 clone can stand on it. */
function publish(seed, name, rev) {
  git(seed, 'push', '-q', 'origin', `${rev}:refs/heads/s-${name}`);
}

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'proved-step-'));
  const origin = join(box, 'origin.git');
  git(box, 'init', '-q', '--bare', '--initial-branch=main', origin);
  git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const seed = join(box, 'seed');
  git(box, 'clone', '-q', origin, seed);

  sha.base = commit(seed, 'a.txt', 'base', 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  // A pull request merged the way GitHub merges one under `strict`: main is behind nothing.
  git(seed, 'checkout', '-q', '-b', 'pr');
  sha.prHead = commit(seed, 'b.txt', 'feature', 'feature');
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'pr');
  sha.merge = git(seed, 'rev-parse', 'HEAD');
  publish(seed, 'merge', sha.merge);

  // The same merge with an edit folded in, so its tree is one no pull request held.
  git(seed, 'checkout', '-q', '--detach', sha.base);
  git(seed, 'merge', '-q', '--no-ff', '--no-commit', sha.prHead);
  writeFileSync(join(seed, 'c.txt'), 'resolved by hand');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Merge by hand');
  sha.evil = git(seed, 'rev-parse', 'HEAD');
  publish(seed, 'evil', sha.evil);

  // Three parents.
  git(seed, 'checkout', '-q', '-b', 'other', sha.base);
  sha.other = commit(seed, 'd.txt', 'other', 'other');
  git(seed, 'checkout', '-q', '--detach', sha.base);
  git(seed, 'merge', '-q', '--no-ff', '-m', 'Octopus', sha.prHead, sha.other);
  sha.octopus = git(seed, 'rev-parse', 'HEAD');
  publish(seed, 'octopus', sha.octopus);

  // A direct push: one parent.
  git(seed, 'checkout', '-q', '--detach', sha.merge);
  sha.single = commit(seed, 'e.txt', 'direct', 'direct push');
  publish(seed, 'single', sha.single);

  // One parent, the PR head, its tree unchanged, and a message a whole-object read would count
  // as a second parent line naming that same proved head.
  git(seed, 'checkout', '-q', '--detach', sha.prHead);
  git(seed, 'commit', '-q', '--allow-empty', '-m', `subject\n\nparent ${sha.prHead}`);
  sha.lying = git(seed, 'rev-parse', 'HEAD');
  publish(seed, 'lying', sha.lying);

  // No branch names the PR head on origin, as none does once GitHub deletes it after the merge:
  // the step reaches it through the merge alone.
  expect(git(origin, 'for-each-ref', '--points-at', sha.prHead)).toBe('');
});

afterAll(() => {
  if (box) rmSync(box, { recursive: true, force: true });
});

const run = (id, status, conclusion) => ({
  id,
  name: 'ci-passed',
  status,
  conclusion,
  app: { slug: 'github-actions' },
});

/** The step's shell, run in a fresh depth-1 clone of the scenario, as GitHub runs `shell: bash`. */
function prove(
  scenario,
  { ref = 'refs/heads/main', event = 'push', checks = {}, ghFails = false },
) {
  const work = mkdtempSync(join(box, 'run-'));
  const clone = join(work, 'clone');
  git(
    work,
    'clone',
    '-q',
    '--depth=1',
    '--branch',
    `s-${scenario}`,
    `file://${box}/origin.git`,
    clone,
  );

  const bin = join(work, 'bin');
  const served = join(work, 'served');
  mkdirSync(bin);
  mkdirSync(served);
  for (const [rev, runs] of Object.entries(checks)) {
    writeFileSync(
      join(served, `${rev}.json`),
      JSON.stringify({ total_count: runs.length, check_runs: runs }),
    );
  }
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s %s\\n' "$1" "$2" >> "${work}/gh-calls"
${ghFails ? 'echo "HTTP 403: Resource not accessible by integration" >&2; exit 1' : ''}
[ "$1" = api ] || { echo "gh stand-in serves only \\\`gh api\\\`" >&2; exit 2; }
path=$2; shift 2
[ "$1" = --jq ] || { echo "gh stand-in needs --jq" >&2; exit 2; }
rev=$(printf '%s' "$path" | sed -n 's#^repos/${REPO}/commits/\\([0-9a-f]*\\)/check-runs?check_name=ci-passed$#\\1#p')
[ -n "$rev" ] || { echo "gh: HTTP 404 for $path" >&2; exit 1; }
body='{"total_count":0,"check_runs":[]}'
[ -f "${served}/$rev.json" ] && body=$(cat "${served}/$rev.json")
printf '%s' "$body" | jq -r "$2"
`,
  );
  chmodSync(gh, 0o755);

  const output = join(work, 'github-output');
  writeFileSync(output, '');
  const script = join(work, 'step.sh');
  writeFileSync(script, stepShell(readFileSync(WORKFLOW, 'utf8'), PROVED_STEP));
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: clone,
    encoding: 'utf8',
    env: {
      ...gitEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GITHUB_REF: ref,
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: REPO,
      GITHUB_OUTPUT: output,
      GH_TOKEN: 'stand-in',
    },
  });
  const outputs = readFileSync(output, 'utf8').split('\n').filter(Boolean);
  const logged = join(work, 'gh-calls');
  const calls = existsSync(logged) ? readFileSync(logged, 'utf8').split('\n').filter(Boolean) : [];
  return { code: r.status, log: `${r.stdout}${r.stderr}`, outputs, calls, clone };
}

function expectProved(result, value) {
  expect(result.code, result.log).toBe(0);
  expect(result.outputs).toEqual([`proved=${value}`]);
  expect(result.log).toContain(`pull_request run already proved this tree: ${value}`);
}

const green = () => ({ [sha.prHead]: [run(7, 'completed', 'success')] });

describe('the proved step, run as ci.yml writes it', () => {
  it('stands in a runtime where rev-list reads a merge as parentless', () => {
    const r = prove('merge', { checks: green() });
    expect(git(r.clone, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(r.clone, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(1);
  });

  it('proves a two-parent merge on main whose PR head passed ci-passed and shares its tree', () => {
    const r = prove('merge', { checks: green() });
    expectProved(r, true);
    expect(r.calls).toEqual([
      `api repos/${REPO}/commits/${sha.prHead}/check-runs?check_name=ci-passed`,
    ]);
  });

  it('proves the same merge pushed to dev', () => {
    expectProved(prove('merge', { ref: 'refs/heads/dev', checks: green() }), true);
  });

  it('keeps the full gate for a direct single-parent push', () => {
    const r = prove('single', { checks: green() });
    expectProved(r, false);
    expect(r.log).toContain('why: HEAD has 1 parent(s)');
    expect(r.calls).toEqual([]);
  });

  it('keeps the full gate when the PR head latest ci-passed failed, older success or not', () => {
    const checks = {
      [sha.prHead]: [run(7, 'completed', 'success'), run(9, 'completed', 'failure')],
    };
    const r = prove('merge', { checks });
    expectProved(r, false);
    expect(r.log).toContain(`why: ci-passed on ${sha.prHead} reads failure, not success`);
  });

  it('keeps the full gate when the PR head never ran ci-passed', () => {
    const r = prove('merge', {});
    expectProved(r, false);
    expect(r.log).toContain(`why: ci-passed on ${sha.prHead} reads absent, not success`);
  });

  it('does not count a ci-passed another app reported', () => {
    const checks = {
      [sha.prHead]: [{ ...run(7, 'completed', 'success'), app: { slug: 'someone' } }],
    };
    expect(prove('merge', { checks }).log).toContain('reads absent, not success');
  });

  it('keeps the full gate for a merge whose tree its PR head never held', () => {
    const r = prove('evil', { checks: green() });
    expectProved(r, false);
    expect(r.log).toContain(`why: HEAD's tree differs from its second parent ${sha.prHead}'s`);
    expect(r.calls).toEqual([]);
  });

  it('keeps the full gate while the PR head ci-passed is still running', () => {
    const checks = { [sha.prHead]: [run(7, 'completed', 'success'), run(9, 'in_progress', null)] };
    const r = prove('merge', { checks });
    expectProved(r, false);
    expect(r.log).toContain('reads in_progress, not success');
  });

  it('keeps the full gate when the check-runs read fails', () => {
    const r = prove('merge', { checks: green(), ghFails: true });
    expectProved(r, false);
    expect(r.log).toContain(
      `why: could not read ci-passed on ${sha.prHead} from the check-runs API`,
    );
  });

  it('keeps the full gate on a branch the workflow does not gate', () => {
    const r = prove('merge', { ref: 'refs/heads/feature', checks: green() });
    expectProved(r, false);
    expect(r.calls).toEqual([]);
  });

  it('keeps the full gate on a pull_request event', () => {
    const r = prove('merge', { ref: 'refs/pull/1/merge', event: 'pull_request', checks: green() });
    expectProved(r, false);
    expect(r.log).toContain('why: a pull_request event to refs/pull/1/merge');
  });

  it('keeps the full gate for a three-parent merge', () => {
    const r = prove('octopus', { checks: green() });
    expectProved(r, false);
    expect(r.log).toContain('why: HEAD has 3 parent(s)');
  });

  it('reads parents off the header, not a message line that says parent', () => {
    const r = prove('lying', { checks: green() });
    expectProved(r, false);
    expect(r.log).toContain('why: HEAD has 1 parent(s)');
  });
});
