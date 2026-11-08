// Whether each verdict is its issue's builder's, kept beside it (ISS-1070 r5, 0627) so no read
// computes the builder rule (`built-by.ts`) again. This module is the model's one owner: it alone
// writes `verdict_builder_facts`, and it writes them with the rule itself, so the stored flag and the
// rule cannot be two definitions.
//
// The rule's inputs are written all over core (verdicts, check runs, leases, runs, sessions, landings,
// reopens). Each input table's trigger marks the issue in `issue_read_model_stale` inside the writing
// transaction, whoever writes it (0627 names each), and every read of a flag first rewrites the
// marked issues among those it reads (`readWithBuilderFacts`). The verdict door writes the flag of the
// verdict it records in its own transaction (`keepBuilderFacts`). A mark is cleared only at the
// generation the rewrite read, so a write racing the rewrite stays marked and is rewritten next time.

import { type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { reportCondition } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import {
  builderCandidatesAcrossSql,
  declaredBeforeLandingSql,
  verdictByBuilderSql,
} from './built-by.js';

type Executor = Pick<Tx, 'execute'>;

/**
 * Every table the builder rule reads, with the triggers 0627 put on it to mark the issue a write
 * moves. A table the rule comes to read is added here and given a trigger in the same change: the
 * model test reads the rule's statement and the database against this list.
 */
export const BUILDER_INPUT_TABLES = [
  {
    table: 'criterion_verdicts',
    triggers: [
      'forge_builder_inputs_verdicts_ins',
      'forge_builder_inputs_verdicts_upd',
      'forge_builder_inputs_verdicts_del',
    ],
  },
  {
    table: 'issue_check_runs',
    triggers: ['forge_builder_inputs_checks_ins', 'forge_builder_inputs_checks_del'],
  },
  { table: 'issue_leases', triggers: ['forge_builder_inputs_leases'] },
  {
    table: 'pipeline_runs',
    triggers: ['forge_builder_inputs_runs_ins', 'forge_builder_inputs_runs_upd'],
  },
  {
    table: 'agent_sessions',
    triggers: [
      'forge_builder_inputs_sessions_ins',
      'forge_builder_inputs_sessions_upd',
      'forge_builder_inputs_sessions_del',
    ],
  },
  { table: 'issues', triggers: ['forge_builder_inputs_issues'] },
  { table: 'kernel_transitions', triggers: ['forge_builder_inputs_reopens'] },
  { table: 'issue_criteria', triggers: ['forge_builder_inputs_criteria'] },
] as const;

/** The stored builder flag of verdict `verdictId` (a column or expression of the calling query);
 *  null where the model holds none for it, which its reader writes or refuses (`readWithBuilderFacts`). */
export function builderFactSql(verdictId: SQL): SQL<boolean | null> {
  return sql<
    boolean | null
  >`(SELECT vb.by_builder FROM verdict_builder_facts vb WHERE vb.verdict_id = ${verdictId})`;
}

/**
 * Every verdict on `issueIds` with the rule's answer for it, as the live computation: the one
 * definition the model is written from and the drift sweep compares it with.
 */
export function liveBuilderFactsSql(issueIds: readonly string[]): SQL {
  const issueSet = sql`(SELECT unnest(${uuidArray(issueIds)}))`;
  return sql`
    SELECT v.id AS verdict_id, v.issue_id,
           coalesce(${verdictByBuilderSql({
             issueId: sql`v.issue_id`,
             authorUser: sql`v.author_user_id`,
             authorDevice: sql`v.author_device_id`,
             at: sql`v.created_at`,
             runSession: sql`v.run_session_id`,
             candidates: sql`bc.candidates`,
           })}, false) AS by_builder,
           CASE WHEN v.run_session_id IS NULL THEN NULL
                ELSE ${declaredBeforeLandingSql(sql`v.issue_id`, sql`v.run_session_id`)} END
             AS declared_before_landing
      FROM criterion_verdicts v
     CROSS JOIN (SELECT ${builderCandidatesAcrossSql(issueSet)} AS candidates) bc
     WHERE v.issue_id = ANY(${uuidArray(issueIds)})`;
}

interface Mark {
  issue_id: string;
  gen: number | string;
}

/**
 * Rewrites the facts of every verdict on the marked issues `marks` from the rule, and clears each mark
 * still at the generation read; a mark a racing write moved on, or holds locked, stays. One statement.
 */
async function rewrite(ex: Executor, marks: readonly Mark[]): Promise<void> {
  if (marks.length === 0) return;
  const ids = marks.map((m) => m.issue_id);
  const gens = sql`${sql.param(marks.map((m) => String(m.gen)))}::bigint[]`;
  await ex.execute(sql`
    WITH live AS (${liveBuilderFactsSql(ids)}),
    kept AS (
      INSERT INTO verdict_builder_facts AS f (verdict_id, issue_id, by_builder, declared_before_landing)
      SELECT verdict_id, issue_id, by_builder, declared_before_landing FROM live ORDER BY verdict_id
      ON CONFLICT (verdict_id) DO UPDATE
        SET issue_id = EXCLUDED.issue_id, by_builder = EXCLUDED.by_builder,
            declared_before_landing = EXCLUDED.declared_before_landing, computed_at = now()
        WHERE (f.issue_id, f.by_builder, f.declared_before_landing)
              IS DISTINCT FROM (EXCLUDED.issue_id, EXCLUDED.by_builder, EXCLUDED.declared_before_landing)
      RETURNING 1),
    cleared AS (
      DELETE FROM issue_read_model_stale s
       WHERE s.issue_id IN (
         SELECT x.issue_id FROM issue_read_model_stale x
           JOIN unnest(${uuidArray(ids)}, ${gens}) AS seen(issue_id, gen)
             ON seen.issue_id = x.issue_id AND seen.gen = x.gen
          ORDER BY x.issue_id
            FOR UPDATE OF x SKIP LOCKED)
      RETURNING 1)
    SELECT (SELECT count(*) FROM kept) AS kept, (SELECT count(*) FROM cleared) AS cleared`);
}

async function marksOf(ex: Executor, issueIds: readonly string[]): Promise<Mark[]> {
  if (issueIds.length === 0) return [];
  return (await ex.execute(sql`
    SELECT issue_id, gen FROM issue_read_model_stale
     WHERE issue_id = ANY(${uuidArray([...new Set(issueIds)])})
     ORDER BY issue_id`)) as unknown as Mark[];
}

/**
 * Writes the facts of every verdict on `issueIds` now, inside the caller's transaction: the verdict
 * door calls it over the verdict it records, so the builder rule is computed when the verdict is
 * written. Its own mark, made by the same transaction, is cleared with it.
 */
export async function keepBuilderFacts(ex: Executor, issueIds: readonly string[]): Promise<void> {
  const unique = [...new Set(issueIds)];
  if (unique.length === 0) return;
  const marks = await marksOf(ex, unique);
  const at = new Map(marks.map((m) => [m.issue_id, m.gen]));
  // an issue with no mark is rewritten too: the door asks for it whatever was marked
  await rewrite(
    ex,
    unique.map((id) => ({ issue_id: id, gen: at.get(id) ?? -1 })),
  );
}

/**
 * Whether the fact of verdict `verdictId` on issue `issueId` is owed rather than held: the model holds
 * none for it, or the issue is marked since its facts were written. A read selects it beside each
 * verdict, so a current model costs no statement of its own (`readWithBuilderFacts`).
 */
export function builderFactOwedSql(issueId: SQL, verdictId: SQL): SQL<boolean> {
  return sql<boolean>`(NOT EXISTS (SELECT 1 FROM verdict_builder_facts vo WHERE vo.verdict_id = ${verdictId})
    OR EXISTS (SELECT 1 FROM issue_read_model_stale so WHERE so.issue_id = ${issueId}))`;
}

/** Whether issue `issueId` is marked since its facts were written: a read over many verdicts asks it
 *  once an issue rather than once a verdict. */
export function builderFactsMarkedSql(issueId: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM issue_read_model_stale sm WHERE sm.issue_id = ${issueId})`;
}

/** Whether the model holds no fact at all for verdict `verdictId`. */
export function builderFactMissingSql(verdictId: SQL): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM verdict_builder_facts vm WHERE vm.verdict_id = ${verdictId})`;
}

/** The model joined beside verdict `verdictId` as `vb`, for a read over many verdicts. */
export function builderFactJoinSql(verdictId: SQL): SQL {
  return sql`LEFT JOIN verdict_builder_facts vb ON vb.verdict_id = ${verdictId}`;
}

/**
 * The columns a read selects from the joined model (`builderFactJoinSql`) beside verdict rows of
 * issue `issueId`: `by_builder`, `fact_declared`, `fact_missing` and `fact_owed`.
 */
export function builderFactColumnsSql(issueId: SQL): SQL {
  return sql`vb.by_builder, vb.declared_before_landing AS fact_declared,
    (vb.verdict_id IS NULL) AS fact_missing,
    (vb.verdict_id IS NULL OR ${builderFactsMarkedSql(issueId)}) AS fact_owed`;
}

/** A row's owed fact: its issue, and whether the model holds no fact for its verdict at all. */
export interface OwedFact {
  issueId: string;
  missing: boolean;
}

const READ_ATTEMPTS = 3;

/**
 * Reads `read`, whose rows say by `owed` where a verdict's fact is owed (`builderFactOwedSql`): where
 * any is, those issues' facts are written and the read made again. A mark a write made after that
 * rewrite is that write's, and the read stands as of the rewrite; a verdict still holding no fact
 * after {@link READ_ATTEMPTS} reads is refused by name, since the owner wrote none for it.
 */
export async function readWithBuilderFacts<R>(
  ex: Executor,
  read: () => PromiseLike<R[]>,
  owed: (row: R) => OwedFact | null,
): Promise<R[]> {
  let rows = await read();
  for (let attempt = 1; ; attempt += 1) {
    const due = rows.flatMap((r) => owed(r) ?? []);
    const missing = due.filter((d) => d.missing);
    if (due.length === 0 || (attempt > 1 && missing.length === 0)) return rows;
    if (attempt >= READ_ATTEMPTS)
      throw new Error(
        `builder-facts: verdicts on issue(s) ${[...new Set(missing.map((m) => m.issueId))].join(', ')} hold no builder fact after their facts were written ${READ_ATTEMPTS - 1} times (verdict_builder_facts, issues/builder-facts.ts)`,
      );
    await keepBuilderFacts(
      ex,
      (attempt > 1 ? missing : due).map((d) => d.issueId),
    );
    rows = await read();
  }
}

/** Marked issues, oldest mark first, up to `limit`: what the drain rewrites (`drainStaleBuilderFacts`). */
export async function drainStaleBuilderFacts(ex: Executor, limit = 200): Promise<number> {
  const marks = (await ex.execute(sql`
    SELECT issue_id, gen FROM issue_read_model_stale ORDER BY marked_at, issue_id LIMIT ${limit}`)) as unknown as Mark[];
  await rewrite(ex, marks);
  return marks.length;
}

/** One verdict whose stored fact differs from the rule's live answer, where its issue is unmarked. */
export interface BuilderFactDrift {
  verdictId: string;
  issueId: string;
  stored: { byBuilder: boolean | null; declaredBeforeLanding: string | null };
  live: { byBuilder: boolean; declaredBeforeLanding: string | null };
}

/**
 * The verdicts on `issueIds` whose stored fact is not what the rule answers now, skipping issues
 * marked stale (a mark says the fact is owed, not wrong). It repairs nothing: the sweep reports.
 */
export async function builderFactDrift(
  ex: Executor,
  issueIds: readonly string[],
): Promise<BuilderFactDrift[]> {
  if (issueIds.length === 0) return [];
  const rows = (await ex.execute(sql`
    WITH live AS (${liveBuilderFactsSql(issueIds)})
    SELECT live.verdict_id, live.issue_id, live.by_builder AS live_builder,
           live.declared_before_landing AS live_declared,
           f.by_builder AS stored_builder, f.declared_before_landing AS stored_declared
      FROM live
      LEFT JOIN verdict_builder_facts f ON f.verdict_id = live.verdict_id
     WHERE NOT EXISTS (SELECT 1 FROM issue_read_model_stale s WHERE s.issue_id = live.issue_id)
       AND (f.verdict_id IS NULL
            OR (f.by_builder, f.declared_before_landing)
               IS DISTINCT FROM (live.by_builder, live.declared_before_landing))
     ORDER BY live.issue_id, live.verdict_id`)) as unknown as {
    verdict_id: string;
    issue_id: string;
    live_builder: boolean;
    live_declared: string | null;
    stored_builder: boolean | null;
    stored_declared: string | null;
  }[];
  return rows.map((r) => ({
    verdictId: r.verdict_id,
    issueId: r.issue_id,
    stored: { byBuilder: r.stored_builder, declaredBeforeLanding: r.stored_declared },
    live: { byBuilder: r.live_builder, declaredBeforeLanding: r.live_declared },
  }));
}

/** Issues the drift sweep weighs each pass: the newest verdicts' issues, and as many at random. */
const SWEEP_NEWEST = 200;
const SWEEP_RANDOM = 200;
/** Marked issues the sweep rewrites each pass, oldest first, so a mark no read reaches still ends. */
const SWEEP_DRAIN = 500;

/** One pass's account: marks rewritten, issues weighed, verdicts whose fact drifted. */
export interface BuilderFactSweep {
  drained: number;
  weighed: number;
  drift: BuilderFactDrift[];
}

/**
 * The drift sweep (ISS-1070 r5): rewrites the oldest marks no read has reached, then weighs the model
 * against the rule, live, for the issues with the newest verdicts and as many at random. A drift is an
 * input some write moved without its trigger marking the issue: it is logged as an error and reported,
 * and never repaired here, so the write that got past the trigger is found rather than hidden.
 */
export async function sweepBuilderFacts(ex: Executor = db): Promise<BuilderFactSweep> {
  const drained = await drainStaleBuilderFacts(ex, SWEEP_DRAIN);
  const sample = (await ex.execute(sql`
    (SELECT issue_id FROM criterion_verdicts GROUP BY issue_id ORDER BY max(created_at) DESC LIMIT ${SWEEP_NEWEST})
    UNION
    (SELECT issue_id FROM (SELECT DISTINCT issue_id FROM verdict_builder_facts) d ORDER BY random() LIMIT ${SWEEP_RANDOM})`)) as unknown as {
    issue_id: string;
  }[];
  const ids = sample.map((r) => r.issue_id);
  const drift = await builderFactDrift(ex, ids);
  if (drift.length > 0) {
    const extra = { drift: drift.slice(0, 20), count: drift.length };
    logger.error(extra, 'builder-facts: the model holds a builder fact the rule no longer answers');
    reportCondition('builder-facts: drift between verdict_builder_facts and the builder rule', {
      level: 'error',
      extra,
    });
  }
  return { drained, weighed: ids.length, drift };
}

/** The drift sweep as the cluster timer runs it (`timer-registry.ts`), every ten minutes. */
export async function builderFactsTick(): Promise<void> {
  const { drained, weighed, drift } = await sweepBuilderFacts();
  if (drained > 0) logger.info({ drained, weighed, drifted: drift.length }, 'builder-facts: swept');
}
