/**
 * ISS-1053 - `bench:assistant history` and `compare-history`: a window of chat_logs rows read
 * through the API and graded per row, and two such files side by side. Read-only: the result
 * files are the only writes.
 */

import type { CliDeps, Env } from '../cli.js';
import { type BenchClient, createClient } from '../client.js';
import { extractIssueLinks, type LinkOutcome } from '../grade.js';
import { readResult } from '../result.js';
import { compareHistory, compareHistoryLines } from './compare.js';
import { type GradeRowOptions, gradeRow } from './grade-row.js';
import { type HistoryResult, readHistoryResult, serializeHistory } from './result.js';
import { type HistoryRow, readWindow } from './row.js';
import { type Graded, summarize } from './summarize.js';

export const HISTORY_USAGE = [
  'bench:assistant history --api <url> --project <slug> --from <date> --to <date> --out <file> [--source s] [--resolve] [--budget-seconds 60] [--max-iterations 8] [--exclude run.json]...',
  'bench:assistant compare-history <before.json> <after.json>',
];

export class HistoryRefusal extends Error {}

interface Flags {
  values: Record<string, string>;
  excludes: string[];
  resolve: boolean;
}

function flags(argv: string[]): Flags {
  const out: Flags = { values: {}, excludes: [], resolve: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new HistoryRefusal(`unexpected argument ${arg}`);
    if (arg === '--resolve') {
      out.resolve = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new HistoryRefusal(`${arg} needs a value`);
    if (arg === '--exclude') out.excludes.push(value);
    else out.values[arg.slice(2)] = value;
    i += 1;
  }
  return out;
}

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new HistoryRefusal(`--${name} must be a positive number, got ${raw}`);
  return n;
}

async function signIn(client: BenchClient, env: Env): Promise<void> {
  if (env.FORGE_BENCH_TOKEN) {
    client.useToken(env.FORGE_BENCH_TOKEN);
    return;
  }
  if (env.FORGE_BENCH_EMAIL && env.FORGE_BENCH_PASSWORD) {
    await client.signIn(env.FORGE_BENCH_EMAIL, env.FORGE_BENCH_PASSWORD);
    return;
  }
  throw new HistoryRefusal(
    'no credential: set FORGE_BENCH_TOKEN, or both FORGE_BENCH_EMAIL and FORGE_BENCH_PASSWORD (read from the environment only)',
  );
}

/** The bench rooms every `--exclude` run file lists, by `cleanup.room.id`. */
async function excludedSessions(deps: CliDeps, files: string[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const file of files) {
    const run = readResult(await deps.readFile(file), file);
    for (const task of run.tasks) {
      for (const trial of task.trials) {
        if (trial.cleanup.room.id) ids.add(trial.cleanup.room.id);
      }
    }
  }
  return [...ids].sort();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One lookup per distinct UUID link across the window, only under `--resolve`. */
async function lookups(
  client: BenchClient,
  rows: HistoryRow[],
): Promise<Record<string, LinkOutcome>> {
  const out: Record<string, LinkOutcome> = {};
  for (const row of rows) {
    for (const link of extractIssueLinks(row.reply ?? '')) {
      if (UUID_RE.test(link.segment) && out[link.segment] === undefined)
        out[link.segment] = await client.issueExists(link.segment);
    }
  }
  return out;
}

async function history(argv: string[], env: Env, deps: CliDeps): Promise<number> {
  const f = flags(argv);
  for (const need of ['api', 'project', 'from', 'to', 'out']) {
    if (!f.values[need])
      throw new HistoryRefusal(`--${need} is required\n${HISTORY_USAGE.join('\n')}`);
  }
  const budgetSeconds = positive('budget-seconds', f.values['budget-seconds'], 60);
  const maxIterations = positive('max-iterations', f.values['max-iterations'], 8);
  const window = {
    projectSlug: f.values.project ?? '',
    from: f.values.from ?? '',
    to: f.values.to ?? '',
    ...(f.values.source ? { source: f.values.source } : {}),
  };
  const client = createClient({ api: f.values.api ?? '', fetch: deps.fetch, timeoutMs: 120_000 });
  await signIn(client, env);
  const version = await client.version();
  const excluded = await excludedSessions(deps, f.excludes);
  const rows = await readWindow(client, window);
  const opts: GradeRowOptions = { budgetSeconds, maxIterations };
  if (f.resolve) opts.lookups = await lookups(client, rows);
  const graded: Graded[] = rows.map((row) => ({ row, grade: gradeRow(row, opts) }));
  const summary = summarize(graded, new Set(excluded));
  const result: HistoryResult = {
    at: deps.now().toISOString(),
    api: f.values.api ?? '',
    commit: version.sourceCommit,
    version: version.version,
    window: { ...window, source: f.values.source ?? null },
    budgetSeconds,
    maxIterations,
    resolved: f.resolve,
    excludedSessions: excluded,
    ...summary,
  };
  await deps.writeFile(f.values.out ?? '', serializeHistory(result));
  for (const g of result.groups) {
    const flagged = result.flagged.filter(
      (r) => r.model === g.model && r.source === g.source,
    ).length;
    deps.stdout(
      `${g.model} / ${g.source}: ${g.rows} rows, ${flagged} flagged${g.thin ? ' (thin)' : ''}`,
    );
  }
  deps.stdout(
    `excluded ${result.excludedRows} row(s) of ${excluded.length} bench room(s); wrote ${f.values.out}`,
  );
  return 0;
}

async function compareFiles(argv: string[], deps: CliDeps): Promise<number> {
  const [before, after] = argv;
  if (!before || !after)
    throw new HistoryRefusal(
      `compare-history needs two history files\n${HISTORY_USAGE.join('\n')}`,
    );
  const a = readHistoryResult(await deps.readFile(before), before);
  const b = readHistoryResult(await deps.readFile(after), after);
  for (const line of compareHistoryLines(compareHistory(a, b))) deps.stdout(line);
  return 0;
}

/** `history` or `compare-history`; anything else is refused with the usage. */
export async function historyMain(
  verb: string,
  rest: string[],
  env: Env,
  deps: CliDeps,
): Promise<number> {
  try {
    if (verb === 'history') return await history(rest, env, deps);
    if (verb === 'compare-history') return await compareFiles(rest, deps);
    throw new HistoryRefusal(HISTORY_USAGE.join('\n'));
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
