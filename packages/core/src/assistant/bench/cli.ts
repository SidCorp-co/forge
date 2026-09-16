/**
 * ISS-1051 — `bench:assistant run` and `bench:assistant compare`. Credentials come from the
 * environment and nowhere else; an unknown task id is refused with the ids shipped; the run
 * writes one result file and prints per-task counts, never a total.
 */

import { adviceInputsOfHistory, adviceInputsOfRun, adviceLines, advise } from './advice.js';
import { createClient, type FetchLike } from './client.js';
import { compare, compareLines, sideOf } from './compare.js';
import { HISTORY_USAGE, historyMain } from './history/cli.js';
import { readHistoryResult } from './history/result.js';
import { isVerdict, type Judge, judgeFromEnv, tally, tallyLine } from './judge.js';
import { ladderLines, ladderMarkdown, rankRuns, rankWindows } from './ladder.js';
import { type BenchResult, readResult, serializeResult, type TaskResult } from './result.js';
import { runTrial } from './run.js';
import type { Task } from './task.js';
import { loadTasks } from './tasks/index.js';

export interface CliDeps {
  fetch: FetchLike;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => Date;
  /** Eight hex characters for the run id. */
  randomId: () => string;
}

export type Env = Record<string, string | undefined>;

export const USAGE = [
  'bench:assistant run --api <url> --project <slug> --out <file> [--tasks a,b] [--trials 3] [--k 3] [--judge <model>]',
  'bench:assistant compare <before.json> <after.json>',
  'bench:assistant ladder <run.json>... [--history <history.json>]... [--out ladder.md]',
  'bench:assistant advise <run.json|history.json>',
  ...HISTORY_USAGE,
  'credentials: FORGE_BENCH_TOKEN, or FORGE_BENCH_EMAIL and FORGE_BENCH_PASSWORD',
  'judge (--judge): FORGE_BENCH_JUDGE_URL and FORGE_BENCH_JUDGE_KEY; the verdict is stored beside the modes and never read into pass',
];

class Refusal extends Error {}

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new Refusal(`unexpected argument ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Refusal(`${arg} needs a value`);
    out[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

function pickTasks(spec: string | undefined): Task[] {
  const all = loadTasks();
  if (!spec) return all;
  const ids = new Set(all.map((t) => t.id));
  const wanted = spec.split(',').map((s) => s.trim());
  const unknown = wanted.filter((id) => !ids.has(id));
  if (unknown.length > 0)
    throw new Refusal(`unknown task id ${unknown.join(', ')}; shipped: ${[...ids].join(', ')}`);
  return all.filter((t) => wanted.includes(t.id));
}

async function signIn(client: ReturnType<typeof createClient>, env: Env): Promise<void> {
  if (env.FORGE_BENCH_TOKEN) {
    client.useToken(env.FORGE_BENCH_TOKEN);
    return;
  }
  if (env.FORGE_BENCH_EMAIL && env.FORGE_BENCH_PASSWORD) {
    await client.signIn(env.FORGE_BENCH_EMAIL, env.FORGE_BENCH_PASSWORD);
    return;
  }
  throw new Refusal(
    'no credential: set FORGE_BENCH_TOKEN, or both FORGE_BENCH_EMAIL and FORGE_BENCH_PASSWORD (read from the environment only)',
  );
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Refusal(`--${name} must be a positive integer, got ${raw}`);
  return n;
}

async function run(argv: string[], env: Env, deps: CliDeps): Promise<number> {
  const f = flags(argv);
  for (const need of ['api', 'project', 'out']) {
    if (!f[need]) throw new Refusal(`--${need} is required\n${USAGE.join('\n')}`);
  }
  const trials = positiveInt('trials', f.trials, 3);
  const k = positiveInt('k', f.k, 3);
  const tasks = pickTasks(f.tasks);
  const judge: Judge | undefined = f.judge ? judgeFromEnv(env, f.judge, deps.fetch) : undefined;
  const client = createClient({ api: f.api ?? '', fetch: deps.fetch, timeoutMs: 10 * 60_000 });
  await signIn(client, env);
  const version = await client.version();
  const project = await client.projectBySlug(f.project ?? '');
  const runId = deps.randomId();
  deps.stdout(
    `run ${runId} against ${f.api} (${version.sourceCommit ?? 'unknown commit'}), project ${project.slug}`,
  );

  let model: string | null = null;
  const results: TaskResult[] = [];
  for (const task of tasks) {
    const row: TaskResult = { id: task.id, trials: [] };
    for (let i = 0; i < trials; i += 1) {
      const trial = await runTrial({
        client,
        task,
        project,
        runId,
        now: deps.now,
        log: deps.stderr,
        ...(judge ? { judge } : {}),
      });
      model ??= trial.model;
      row.trials.push(trial.result);
      // cm:guard a judge that is the model under test grades its own habits kindly; the trial it was refused on is kept whole (grades, room id) so the partial file still excludes that room from a history reading
      if (trial.judgeRefused) {
        results.push(row);
        await writeResult(deps, f, version, model, runId, k, results, judge);
        throw new Refusal(
          `${task.id} trial ${i + 1}: ${trial.judgeRefused}; no further trial started, partial results written to ${f.out}`,
        );
      }
      // cm:guard a restore that failed must not become the next trial's baseline: the next trial would read the moved value as the account's own and restore to it, and the run would end "clean" with the person's preference changed
      if (trial.result.cleanup.preferences.equal === false) {
        results.push(row);
        await writeResult(deps, f, version, model, runId, k, results, judge);
        const { observed, expected } = trial.result.cleanup.preferences;
        throw new Refusal(
          `${task.id} trial ${i + 1}: preference restore failed (${JSON.stringify(observed)} read back against ${JSON.stringify(expected)}); no further trial started, partial results written to ${f.out}`,
        );
      }
    }
    const side = sideOf(row.trials, k);
    deps.stdout(`${task.id}: ${side.s}/${side.n} trials passed`);
    if (judge) {
      const verdicts = row.trials.flatMap((t) =>
        t.turns.flatMap((turn) => (turn.judge ? [turn.judge] : [])),
      );
      const t = tally(verdicts);
      const rejected = verdicts.filter((v) => isVerdict(v) && v.served === 'no').length;
      deps.stdout(
        `${task.id}: ${tallyLine(t)}${rejected > 0 ? ' (read the judge.reason on each)' : ''}`,
      );
    }
    results.push(row);
  }
  await writeResult(deps, f, version, model, runId, k, results, judge);
  return 0;
}

async function writeResult(
  deps: CliDeps,
  f: Record<string, string>,
  version: { version: string; sourceCommit: string | null },
  model: string | null,
  runId: string,
  k: number,
  tasks: TaskResult[],
  judge: Judge | undefined,
): Promise<void> {
  const result: BenchResult = {
    at: deps.now().toISOString(),
    api: f.api ?? '',
    commit: version.sourceCommit,
    version: version.version,
    model,
    runId,
    k,
    tasks,
    ...(judge ? { judge: { model: judge.model } } : {}),
  };
  await deps.writeFile(f.out ?? '', serializeResult(result));
  deps.stdout(`wrote ${f.out}`);
}

async function compareFiles(argv: string[], deps: CliDeps): Promise<number> {
  const [before, after] = argv;
  if (!before || !after) throw new Refusal(`compare needs two result files\n${USAGE.join('\n')}`);
  const a = readResult(await deps.readFile(before), before);
  const b = readResult(await deps.readFile(after), after);
  for (const line of compareLines(compare(a, b))) deps.stdout(line);
  return 0;
}

/** Run files ranked on one printed score, history windows ranked beside them; Markdown to `--out`. */
async function ladder(argv: string[], deps: CliDeps): Promise<number> {
  const runFiles: string[] = [];
  const historyFiles: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--history' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Refusal(`${arg} needs a value`);
      if (arg === '--history') historyFiles.push(value);
      else out = value;
      i += 1;
    } else if (arg.startsWith('--')) throw new Refusal(`unknown flag ${arg}\n${USAGE.join('\n')}`);
    else runFiles.push(arg);
  }
  if (runFiles.length === 0)
    throw new Refusal(`ladder needs at least one run file\n${USAGE.join('\n')}`);
  const runs = rankRuns(
    await Promise.all(
      runFiles.map(async (name) => ({ name, result: readResult(await deps.readFile(name), name) })),
    ),
  );
  const windows = rankWindows(
    await Promise.all(
      historyFiles.map(async (name) => ({
        name,
        result: readHistoryResult(await deps.readFile(name), name),
      })),
    ),
  );
  for (const line of ladderLines(runs, windows)) deps.stdout(line);
  if (out) {
    await deps.writeFile(out, ladderMarkdown(runs, windows));
    deps.stdout(`wrote ${out}`);
  }
  return 0;
}

/** The advice block for one file, read as a run file first and as a history file second. */
async function adviseFile(argv: string[], deps: CliDeps): Promise<number> {
  const [file, extra] = argv;
  if (!file || extra !== undefined)
    throw new Refusal(`advise needs exactly one run or history file\n${USAGE.join('\n')}`);
  const text = await deps.readFile(file);
  let inputs: ReturnType<typeof adviceInputsOfRun>;
  try {
    inputs = adviceInputsOfRun(readResult(text, file));
  } catch (runErr) {
    try {
      inputs = adviceInputsOfHistory(readHistoryResult(text, file));
    } catch (historyErr) {
      const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      throw new Refusal(
        `${file} is neither a run file (${why(runErr)}) nor a history file (${why(historyErr)})`,
      );
    }
  }
  for (const line of adviceLines(advise(inputs))) deps.stdout(line);
  return 0;
}

/** Exit code: 0 for a run, comparison, ladder or advice that completed, 1 for a refusal or a deployment error. */
export async function main(argv: string[], env: Env, deps: CliDeps): Promise<number> {
  const [verb, ...rest] = argv;
  try {
    if (verb === 'run') return await run(rest, env, deps);
    if (verb === 'compare') return await compareFiles(rest, deps);
    if (verb === 'ladder') return await ladder(rest, deps);
    if (verb === 'advise') return await adviseFile(rest, deps);
    if (verb === 'history' || verb === 'compare-history')
      return await historyMain(verb, rest, env, deps);
    throw new Refusal(USAGE.join('\n'));
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
