import { spawnSync } from 'node:child_process';

/**
 * One validation of a combination: the project's declared `gate`, prepared and run once in the
 * window's tree, timed. The time is the window's cost figure — what one pass took and how many
 * members shared it — which is the only evidence the window is worth its complexity.
 */

const WORDS = 40;

function timed(argv, cwd) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return {
    status: r.error ? null : r.status,
    error: r.error?.message,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Why `tree` is not exactly the commit a pass is recorded against, or `null`: its HEAD is elsewhere,
 * or it holds a change or an untracked file the commit does not, which the gate would read as the
 * combination's own.
 */
function driftOf(tree, head, when) {
  const git = (args) => spawnSync('git', args, { cwd: tree, encoding: 'utf8' });
  const at = git(['rev-parse', 'HEAD']);
  if (at.status !== 0) return `${tree} is not a git worktree ${when}`;
  if (at.stdout.trim() !== head) {
    return `${tree} is at ${at.stdout.trim()}, not the chain head ${head}, ${when}`;
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=normal']);
  if (dirty.status !== 0) return `git status did not answer in ${tree} ${when}`;
  const lines = dirty.stdout.split('\n').filter(Boolean);
  if (lines.length > 0) {
    return `${tree} holds changes the chain head does not ${when} (${lines.slice(0, 3).join('; ')})`;
  }
  return null;
}

/**
 * @param {{ tree: string, head: string, gate: { prepare: string[][], run: string[] } }} input
 * @returns {{ refusal: string, output: string } | { status: number, seconds: number,
 *   prepareSeconds: number, output: string, words: string|null }}
 */
export function runGate({ tree, head, gate }) {
  const notRun = 'so the gate was not run and nothing was validated';
  const before = driftOf(tree, head, 'before preparing');
  if (before) return { refusal: `${before}, ${notRun}`, output: '' };
  let output = '';
  let prepareSeconds = 0;
  for (const argv of gate.prepare) {
    const step = timed(argv, tree);
    prepareSeconds += step.seconds;
    output += `$ ${argv.join(' ')}\n${step.stdout}${step.stderr}\n`;
    if (step.status !== 0) {
      return {
        refusal: `\`${argv.join(' ')}\` did not prepare ${tree} (${step.error ?? `exit ${step.status}`}), ${notRun}`,
        output,
      };
    }
  }
  const after = driftOf(tree, head, 'after preparing');
  if (after) return { refusal: `${after}, ${notRun}`, output };
  const run = timed(gate.run, tree);
  output += `$ ${gate.run.join(' ')}\n${run.stdout}${run.stderr}`;
  const status = run.status === 0 ? 0 : run.status === 1 ? 1 : 2;
  const said = run.stderr.trim() || run.stdout.trim();
  return {
    status,
    seconds: run.seconds,
    prepareSeconds: Math.round(prepareSeconds * 10) / 10,
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
