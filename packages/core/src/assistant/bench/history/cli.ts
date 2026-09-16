/**
 * ISS-1053 - `bench:assistant history` and `compare-history`: a window of chat_logs rows read
 * through the API and graded per row, and two such files side by side. Read-only: the result
 * files are the only writes.
 */

import type { CliDeps, Env } from '../cli.js';
import { type BenchClient, createClient } from '../client.js';
import { extractIssueLinks, type LinkOutcome } from '../grade.js';
import { agreement, callLines, type Judge, judgeFromEnv, tally, tallyLine } from '../judge.js';
import { readResult } from '../result.js';
import { readAttempt } from '../trail.js';
import { compareHistory, compareHistoryLines } from './compare.js';
import { type GradeRowOptions, gradeRow } from './grade-row.js';
import {
  type HistoryJudge,
  type HistoryResult,
  type JudgedRow,
  type JudgeGroup,
  readHistoryResult,
  serializeHistory,
} from './result.js';
import { type HistoryRow, readWindow } from './row.js';
import { type Graded, NONE, summarize } from './summarize.js';

export const HISTORY_USAGE = [
  'bench:assistant history --api <url> --project <slug> --from <date> --to <date> --out <file> [--source s] [--resolve] [--budget-seconds 60] [--max-iterations 8] [--exclude run.json]... [--judge <model> [--judge-sample 40]]',
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

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const n = positive(name, raw, fallback);
  if (!Number.isInteger(n))
    throw new HistoryRefusal(`--${name} must be a positive integer, got ${raw}`);
  return n;
}

const newestFirst = (a: HistoryRow, b: HistoryRow): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * The newest `sample` kept rows judged one by one, after the rules have graded them. Refused by
 * name before any call when the judge is a model the window names: a model must not grade itself.
 */
async function judgeHistory(
  judge: Judge,
  sample: number,
  graded: Graded[],
  groups: Array<{ model: string; source: string }>,
): Promise<HistoryJudge> {
  const same = groups.find((g) => g.model === judge.model);
  if (same)
    throw new HistoryRefusal(
      `judge ${judge.model} is a model under test (group ${same.model} / ${same.source}); no row judged`,
    );
  const picked = [...graded].sort((x, y) => newestFirst(x.row, y.row)).slice(0, sample);
  const rows: JudgedRow[] = [];
  for (const { row, grade } of picked) {
    const result = await judge.judge({
      query: row.query ?? '',
      reply: row.reply?.trim() ? row.reply : null,
      calls: callLinesOf(row),
      error: row.error,
    });
    rows.push({
      chatLogId: row.id,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      model: row.model ?? NONE,
      source: row.source ?? NONE,
      modes: grade.modes,
      judge: result,
    });
  }
  const keys = [...new Set(rows.map((r) => `${r.model}\u0000${r.source}`))];
  const byGroup: JudgeGroup[] = keys.map((k) => {
    const [model = '', source = ''] = k.split('\u0000');
    return {
      model,
      source,
      tally: tally(
        rows.filter((r) => r.model === model && r.source === source).map((r) => r.judge),
      ),
    };
  });
  return { model: judge.model, sample, rows, groups: byGroup, agreement: agreement(rows) };
}

const callLinesOf = (row: HistoryRow): string[] => callLines(readAttempt(row).calls);

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
  if (f.values['judge-sample'] !== undefined && !f.values.judge)
    throw new HistoryRefusal('--judge-sample needs --judge <model>');
  const judgeSample = positiveInt('judge-sample', f.values['judge-sample'], 40);
  const judge = f.values.judge ? judgeFromEnv(env, f.values.judge, deps.fetch) : undefined;
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
  const excludedSet = new Set(excluded);
  const isExcluded = (row: HistoryRow) => Boolean(row.sessionId && excludedSet.has(row.sessionId));
  const base: GradeRowOptions = { budgetSeconds, maxIterations };
  // cm:why a link inside an excluded bench room is never fetched: those rows are dropped by
  // summarize, and a lookup the deployment refuses there would abort the whole export (codex F1);
  // so they are graded without lookups and the lookups cover the rows that stay.
  const opts: GradeRowOptions = f.resolve
    ? {
        ...base,
        lookups: await lookups(
          client,
          rows.filter((row) => !isExcluded(row)),
        ),
      }
    : base;
  const graded: Graded[] = rows.map((row) => ({
    row,
    grade: gradeRow(row, isExcluded(row) ? base : opts),
  }));
  const summary = summarize(graded, excludedSet);
  const judged = judge
    ? await judgeHistory(
        judge,
        judgeSample,
        graded.filter(({ row }) => !isExcluded(row)),
        summary.groups,
      )
    : undefined;
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
    ...(judged ? { judge: judged } : {}),
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
  if (judged) {
    deps.stdout(
      `judge ${judged.model} read ${judged.rows.length} of ${judged.sample} asked: ${tallyLine(tally(judged.rows.map((r) => r.judge)))}`,
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
