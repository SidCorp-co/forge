import { spawnSync } from 'node:child_process';

/**
 * One validation of a combination: the project's declared `gate`, prepared and run once in the
 * window's tree, timed. The time is the window's cost figure — what one pass took and how many
 * members shared it — which is the only evidence the window is worth its complexity.
 */

const WORDS = 40;

/** The environment a window's commands run in: the operator's, with the merge target the window's. */
export function windowEnv(base) {
  return { ...process.env, GITHUB_BASE_REF: base };
}

function timed(argv, cwd, env) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  return {
    status: r.error ? null : r.status,
    error: r.error?.message,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** The declared `gate.prepare` steps, in order, so an unprepared tree never reads as a failing one. */
export function prepareTree({ tree, prepare, base }) {
  let output = '';
  let seconds = 0;
  for (const argv of prepare) {
    const step = timed(argv, tree, windowEnv(base));
    seconds += step.seconds;
    output += `$ ${argv.join(' ')}\n${step.stdout}${step.stderr}\n`;
    if (step.status !== 0) {
      return {
        refusal: `\`${argv.join(' ')}\` did not prepare ${tree} (${step.error ?? `exit ${step.status}`})`,
        output,
        seconds,
      };
    }
  }
  return { output, seconds: Math.round(seconds * 10) / 10 };
}

/** Why `tree` is not exactly `head` — HEAD elsewhere, or a change or untracked file — or `null`. */
export function treeDrift(tree, head, when, what = 'the chain head') {
  const git = (args) => spawnSync('git', args, { cwd: tree, encoding: 'utf8' });
  const at = git(['rev-parse', 'HEAD']);
  if (at.status !== 0) return `${tree} is not a git worktree ${when}`;
  if (at.stdout.trim() !== head) {
    return `${tree} is at ${at.stdout.trim()}, not ${what} ${head}, ${when}`;
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=normal']);
  if (dirty.status !== 0) return `git status did not answer in ${tree} ${when}`;
  const lines = dirty.stdout.split('\n').filter(Boolean);
  if (lines.length > 0) {
    return `${tree} holds changes ${what} does not ${when} (${lines.slice(0, 3).join('; ')})`;
  }
  return null;
}

/**
 * @param {{ tree: string, head: string, base: string, gate: { prepare: string[][], run: string[] } }} input
 * @returns {{ refusal: string, output: string } | { status: number, seconds: number,
 *   prepareSeconds: number, output: string, words: string|null }}
 */
export function runGate({ tree, head, base, gate }) {
  const notRun = 'so the gate was not run and nothing was validated';
  const before = treeDrift(tree, head, 'before preparing');
  if (before) return { refusal: `${before}, ${notRun}`, output: '' };
  const prepared = prepareTree({ tree, prepare: gate.prepare, base });
  let output = prepared.output;
  const prepareSeconds = prepared.seconds;
  if (prepared.refusal) return { refusal: `${prepared.refusal}, ${notRun}`, output };
  const after = treeDrift(tree, head, 'after preparing');
  if (after) return { refusal: `${after}, ${notRun}`, output };
  const run = timed(gate.run, tree, windowEnv(base));
  output += `$ ${gate.run.join(' ')}\n${run.stdout}${run.stderr}`;
  const status = run.status === 0 ? 0 : run.status === 1 ? 1 : 2;
  const said = run.stderr.trim() || run.stdout.trim();
  return {
    status,
    seconds: run.seconds,
    prepareSeconds,
    output,
    words: status === 0 ? null : said.split('\n').slice(-WORDS).join('\n'),
  };
}

/** The line a ledger carries for one pass, with its cost shared across the members it proved. */
export function passLine(pass) {
  const each =
    pass.members > 0 ? Math.round((pass.seconds / pass.members) * 10) / 10 : pass.seconds;
  const outcome = pass.status === 0 ? 'green' : pass.status === 1 ? 'red' : 'could not run';
  return (
    `Pass ${pass.n}: \`${pass.command}\` at \`${pass.head}\` took ${pass.seconds}s ` +
    `(prepare ${pass.prepareSeconds}s), shared by ${pass.members} member(s), ${each}s each: ${outcome}`
  );
}
