// @direct-test-of .github/workflows/ci.yml
// @gate-input whole-tree — it runs ci-passed's step under bash, which the guard cannot see
//
// What ci-passed decides, from its own shell in ci.yml (ISS-472; REQ-36 BC-9, BC-15): on a push to
// dev or a pull request into dev merge-check is dev's whole gate and only its success passes; on
// main's push, pull request, schedule and dispatch runs it is skipped by design, and its skip passes
// as every skipped job's does. The step runs here as GitHub would run it, so a change to what it
// accepts goes red here, not first on main after a promotion.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
const JOBS = CI.slice(CI.indexOf('\njobs:\n'));

/** One job's block: its lines up to the next job at the same indent. */
function job(name) {
  const lines = JOBS.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`ci.yml has no job ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The `needs` list of a job, as written inline: `needs: [a, b, …]`. */
function needsOf(name) {
  const listed = /needs:\s*\[([^\]]*)\]/.exec(job(name))?.[1];
  if (listed === undefined) throw new Error(`ci.yml job ${name} has no inline needs list`);
  return listed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The shell of a job's one `run: |` step, dedented, exactly as the runner would receive it. */
function runScriptOf(name) {
  const lines = job(name).split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  if (at === -1) throw new Error(`ci.yml job ${name} has no run: | step`);
  const indent = lines[at].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/**
 * Run ci-passed's step as GitHub would, every `${{ … }}` it names filled from one run's job results.
 * An expression this does not model is refused by name, so a new one cannot pass unread.
 */
function ciPassed({ scoped, results }) {
  const script = runScriptOf('ci-passed').replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (expr === 'needs.changes.outputs.scoped') return scoped ? 'true' : 'false';
    const m = /^needs\.([\w-]+)\.result$/.exec(expr);
    if (!m) throw new Error(`ci-passed reads \${{ ${expr} }}, which this test does not model`);
    if (!(m[1] in results)) throw new Error(`no result given for job ${m[1]}`);
    return results[m[1]];
  });
  const r = spawnSync('bash', ['-e', '-c', script], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every job ci-passed needs, at `rest`, with the named ones overridden. */
const resultsOf = (rest, named = {}) => ({
  ...Object.fromEntries(needsOf('ci-passed').map((n) => [n, rest])),
  changes: 'success',
  ...named,
});

describe('ci-passed needs merge-check on dev and accepts its skip on main (REQ-36 BC-9, BC-15)', () => {
  it('passes a main push, pull request, schedule or dispatch run that skipped merge-check', () => {
    for (const rest of ['success', 'skipped']) {
      const r = ciPassed({ scoped: false, results: resultsOf(rest, { 'merge-check': 'skipped' }) });
      expect([rest, r.status, r.out]).toEqual([
        rest,
        0,
        expect.stringContaining('all jobs passed'),
      ]);
    }
  });

  it('passes a push to dev or a pull request into dev whose merge-check succeeded', () => {
    const r = ciPassed({
      scoped: true,
      results: resultsOf('skipped', { 'merge-check': 'success' }),
    });
    expect(r.status).toBe(0);
  });

  it("is red on dev when merge-check was skipped, naming it as dev's whole gate", () => {
    const r = ciPassed({
      scoped: true,
      results: resultsOf('skipped', { 'merge-check': 'skipped' }),
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("merge-check is dev's whole gate and did not succeed");
    expect(r.out).toContain('result=skipped');
  });

  it('is red wherever merge-check or any other job failed or was cancelled', () => {
    for (const [scoped, named] of [
      [true, { 'merge-check': 'failure' }],
      [true, { 'merge-check': 'cancelled' }],
      [false, { 'merge-check': 'failure' }],
      [false, { 'merge-check': 'skipped', core: 'failure' }],
    ]) {
      const r = ciPassed({ scoped, results: resultsOf('skipped', named) });
      expect([scoped, named, r.status]).toEqual([scoped, named, 1]);
    }
  });

  it('reads the result of every job it needs, and no job it does not', () => {
    const read = [...runScriptOf('ci-passed').matchAll(/needs\.([\w-]+)\.result/g)].map(
      (m) => m[1],
    );
    expect([...new Set(read)].sort()).toEqual([...needsOf('ci-passed')].sort());
  });
});
