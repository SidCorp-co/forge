// Each issue's traced criteria, with the verdicts coverage reads of them, kept per issue (ISS-1070 r7,
// 0633) so no read assembles them again: for a person in twelve projects that one read answered
// 35,640 verdict rows and was most of the attention read's 2.7 s. This module is the model's one
// owner: it alone writes `issue_criteria_facts`, and it writes them with the live read itself
// (`criteria-facts-live.ts:liveIssueCriteria`), so the stored facts and the read cannot be two
// definitions.
//
// The read's inputs are written all over core (verdicts, builder flags, criteria and their classes,
// the requirement criteria they trace, baselines and their pins, workflows, project slugs, reopens,
// attachments). Each input table's trigger marks the issue in `issue_criteria_facts_stale` inside the
// writing transaction, whoever writes it (0633 names each), and every stored read first rewrites the
// marked or missing issues among those it reads (`storedIssueCriteria`). The stored read is taken only
// by `standing-facts.ts:issueCriteriaOf` on the pool with no issue read as back from its reopen;
// inside a transaction, or with an issue read as returned, it reads live. An issue marked for its builder
// facts (`issues/builder-facts.ts`, `issue_read_model_stale`) is owed too: its verdicts' builder flags
// are part of these facts, so they are rewritten first. A mark is cleared only at the generation the
// rewrite read, so a write racing the rewrite stays marked and is rewritten next time. A read never
// answers a stored fact while its issue is marked.

import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { uuidArray } from '../db/raw-sql.js';
import { keepBuilderFacts } from '../issues/index.js';
import { reportCondition } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { liveIssueCriteria } from './criteria-facts-live.js';
import type { StandingIssueCriterion, StandingVerdict } from './standing.js';

type Executor = Pick<Tx, 'execute'>;

/**
 * Every table the live read reads, with the triggers 0633 put on it to mark the issues a write moves.
 * A table the read comes to read is added here and given a trigger in the same change: the model test
 * reads the live statements and the database against this list.
 */
export const CRITERIA_FACT_INPUT_TABLES = [
  {
    table: 'criterion_verdicts',
    triggers: [
      'forge_criteria_facts_verdicts_ins',
      'forge_criteria_facts_verdicts_upd',
      'forge_criteria_facts_verdicts_del',
    ],
  },
  {
    table: 'verdict_builder_facts',
    triggers: [
      'forge_criteria_facts_builder_ins',
      'forge_criteria_facts_builder_upd',
      'forge_criteria_facts_builder_del',
    ],
  },
  {
    table: 'issue_criteria',
    triggers: [
      'forge_criteria_facts_criteria_ins',
      'forge_criteria_facts_criteria_upd',
      'forge_criteria_facts_criteria_del',
    ],
  },
  { table: 'issue_design_criteria', triggers: ['forge_criteria_facts_design'] },
  { table: 'requirement_criteria', triggers: ['forge_criteria_facts_traced'] },
  { table: 'requirement_baselines', triggers: ['forge_criteria_facts_baselines'] },
  { table: 'requirement_baseline_pins', triggers: ['forge_criteria_facts_pins'] },
  {
    table: 'project_workflows',
    triggers: ['forge_criteria_facts_workflows', 'forge_criteria_facts_workflows_del'],
  },
  { table: 'projects', triggers: ['forge_criteria_facts_slugs'] },
  {
    table: 'kernel_transitions',
    triggers: ['forge_criteria_facts_reopens', 'forge_criteria_facts_transitions'],
  },
  { table: 'issue_attachments', triggers: ['forge_criteria_facts_files'] },
] as const;

/** A verdict as stored: its times as ISO strings. */
type StoredVerdict = Omit<StandingVerdict, 'verdictAt' | 'recordedAt'> & {
  verdictAt: string | null;
  recordedAt: string | null;
};
type StoredCriterion = StoredVerdict &
  Omit<StandingIssueCriterion, keyof StandingVerdict | 'earlier' | 'beforeReopen'> & {
    earlier?: StoredVerdict[];
    beforeReopen?: StoredVerdict;
  };

const at = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));

function verdictOf<V extends StoredVerdict>(
  v: V,
): Omit<V, 'verdictAt' | 'recordedAt'> & Pick<StandingVerdict, 'verdictAt' | 'recordedAt'> {
  return { ...v, verdictAt: at(v.verdictAt), recordedAt: at(v.recordedAt) };
}

/** A stored criterion as the live read answers it: its times as dates again. */
function revived(c: StoredCriterion): StandingIssueCriterion {
  const { earlier, beforeReopen, ...own } = c;
  return {
    ...verdictOf(own),
    ...(earlier ? { earlier: earlier.map((v) => verdictOf(v)) } : {}),
    ...(beforeReopen ? { beforeReopen: verdictOf(beforeReopen) } : {}),
  } as StandingIssueCriterion;
}

interface Held {
  issue_id: string;
  criteria: StoredCriterion[] | null;
  /** No fact is held, or the issue is marked since it was written. */
  owed: boolean;
  /** The issue is marked for its builder facts, which these facts carry. */
  builder_marked: boolean;
}

/** What the model holds for each of `issueIds`, in issue order, and whether each is owed. */
async function heldOf(ex: Executor, issueIds: readonly string[]): Promise<Held[]> {
  return (await ex.execute(sql`
    SELECT x.id AS issue_id, f.criteria,
           (f.issue_id IS NULL
             OR EXISTS (SELECT 1 FROM issue_criteria_facts_stale s WHERE s.issue_id = x.id)
             OR EXISTS (SELECT 1 FROM issue_read_model_stale b WHERE b.issue_id = x.id)) AS owed,
           EXISTS (SELECT 1 FROM issue_read_model_stale b WHERE b.issue_id = x.id) AS builder_marked
      FROM unnest(${uuidArray(issueIds)}) AS x(id)
      JOIN issues i ON i.id = x.id
      LEFT JOIN issue_criteria_facts f ON f.issue_id = x.id
     ORDER BY x.id`)) as unknown as Held[];
}

/**
 * Each of `issueIds`' criteria as the live read answers them, from the stored facts: an issue whose
 * fact is missing or marked is written first, from the live read, and answered as written. In the
 * live read's order: by issue, then each issue's criteria in its own order.
 */
export async function storedIssueCriteria(
  issueIds: readonly string[],
  ex: Executor = db,
): Promise<StandingIssueCriterion[]> {
  const unique = [...new Set(issueIds)];
  if (unique.length === 0) return [];
  const held = await heldOf(ex, unique);
  const owed = held.filter((h) => h.owed);
  const written =
    owed.length > 0
      ? await writeFacts(
          ex,
          owed.map((h) => h.issue_id),
          owed.filter((h) => h.builder_marked).map((h) => h.issue_id),
        )
      : new Map<string, StandingIssueCriterion[]>();
  return held.flatMap((h) =>
    h.owed ? (written.get(h.issue_id) ?? []) : (h.criteria ?? []).map(revived),
  );
}

/**
 * Writes the facts of `issueIds` from the live read and clears each mark still at the generation read
 * before it; answers what it wrote, by issue. The builder flags of `builderMarked` are rewritten
 * first, so a fact is never written from a flag its own read would then move.
 */
async function writeFacts(
  ex: Executor,
  issueIds: readonly string[],
  builderMarked: readonly string[],
): Promise<Map<string, StandingIssueCriterion[]>> {
  if (builderMarked.length > 0) await keepBuilderFacts(ex, builderMarked);
  const marks = (await ex.execute(sql`
    SELECT issue_id, gen FROM issue_criteria_facts_stale
     WHERE issue_id = ANY(${uuidArray(issueIds)}) ORDER BY issue_id`)) as unknown as {
    issue_id: string;
    gen: number | string;
  }[];
  const live = await liveIssueCriteria(issueIds, ex, []);
  const byIssue = new Map<string, StandingIssueCriterion[]>(issueIds.map((id) => [id, []]));
  for (const c of live) byIssue.get(c.issueId)?.push(c);
  const facts = JSON.stringify(
    [...byIssue].map(([issue_id, criteria]) => ({ issue_id, criteria })),
  );
  const gens = sql`${sql.param(marks.map((m) => String(m.gen)))}::bigint[]`;
  await ex.execute(sql`
    WITH input AS (
      SELECT x.issue_id, x.criteria FROM jsonb_to_recordset(${facts}::jsonb) AS x(issue_id uuid, criteria jsonb)
    ),
    kept AS (
      INSERT INTO issue_criteria_facts AS f (issue_id, criteria)
      SELECT input.issue_id, input.criteria FROM input JOIN issues i ON i.id = input.issue_id
       ORDER BY input.issue_id
      ON CONFLICT (issue_id) DO UPDATE SET criteria = EXCLUDED.criteria, computed_at = now()
      RETURNING 1),
    cleared AS (
      DELETE FROM issue_criteria_facts_stale s
       WHERE s.issue_id IN (
         SELECT x.issue_id FROM issue_criteria_facts_stale x
           JOIN unnest(${uuidArray(marks.map((m) => m.issue_id))}, ${gens}) AS seen(issue_id, gen)
             ON seen.issue_id = x.issue_id AND seen.gen = x.gen
          ORDER BY x.issue_id
            FOR UPDATE OF x SKIP LOCKED)
      RETURNING 1)
    SELECT (SELECT count(*) FROM kept) AS kept, (SELECT count(*) FROM cleared) AS cleared`);
  return byIssue;
}

/** Rewrites the oldest marked issues, up to `limit`: what boot and the sweep drain. */
export async function drainStaleCriteriaFacts(ex: Executor = db, limit = 200): Promise<number> {
  const marked = (await ex.execute(sql`
    SELECT s.issue_id, EXISTS (SELECT 1 FROM issue_read_model_stale b WHERE b.issue_id = s.issue_id) AS builder_marked
      FROM issue_criteria_facts_stale s
     ORDER BY s.marked_at, s.issue_id LIMIT ${limit}`)) as unknown as {
    issue_id: string;
    builder_marked: boolean;
  }[];
  if (marked.length === 0) return 0;
  // an issue gone since it was marked holds no fact: its mark is cleared with the rest
  await writeFacts(
    ex,
    marked.map((m) => m.issue_id),
    marked.filter((m) => m.builder_marked).map((m) => m.issue_id),
  );
  return marked.length;
}

/** One issue whose stored fact is not what the live read answers now, where it is unmarked. */
export interface CriteriaFactDrift {
  issueId: string;
  stored: unknown;
  live: unknown;
}

/** `v` as JSON with every object's keys in order, so a stored jsonb and a live object compare. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

const marksOn = async (ex: Executor, ids: readonly string[]): Promise<Set<string>> =>
  new Set(
    (
      (await ex.execute(sql`
        SELECT issue_id FROM issue_criteria_facts_stale WHERE issue_id = ANY(${uuidArray(ids)})
        UNION SELECT issue_id FROM issue_read_model_stale WHERE issue_id = ANY(${uuidArray(ids)})`)) as unknown as {
        issue_id: string;
      }[]
    ).map((r) => r.issue_id),
  );

/**
 * What the live read answers for `issueIds`, inside a transaction it rolls back: a builder flag the
 * read writes on its way (`issues/builder-facts.ts:readWithBuilderFacts`) would mark the issue and
 * hide the very drift being weighed, so the weighing writes nothing.
 */
async function liveUnwritten(issueIds: readonly string[]): Promise<StandingIssueCriterion[]> {
  let live: StandingIssueCriterion[] = [];
  const weighed = new Error('criteria-facts: the weighing writes nothing');
  try {
    await db.transaction(async (tx) => {
      live = await liveIssueCriteria(issueIds, tx, []);
      throw weighed;
    });
  } catch (err) {
    if (err !== weighed) throw err;
  }
  return live;
}

/**
 * The issues of `issueIds` whose stored fact is not what the live read answers now, or that hold no
 * fact and no mark, skipping issues marked before or during the weighing (a mark says the fact is
 * owed, not wrong). It repairs nothing, and the live read it weighs against is rolled back: the sweep
 * reports.
 */
export async function criteriaFactDrift(
  ex: Executor,
  issueIds: readonly string[],
): Promise<CriteriaFactDrift[]> {
  const unique = [...new Set(issueIds)];
  if (unique.length === 0) return [];
  const before = await marksOn(ex, unique);
  const weighed = unique.filter((id) => !before.has(id));
  if (weighed.length === 0) return [];
  const stored = new Map(
    (
      (await ex.execute(sql`
        SELECT x.id AS issue_id, f.criteria FROM unnest(${uuidArray(weighed)}) AS x(id)
          JOIN issues i ON i.id = x.id
          LEFT JOIN issue_criteria_facts f ON f.issue_id = x.id`)) as unknown as {
        issue_id: string;
        criteria: StoredCriterion[] | null;
      }[]
    ).map((r) => [r.issue_id, r.criteria]),
  );
  const live = new Map<string, StandingIssueCriterion[]>([...stored.keys()].map((id) => [id, []]));
  for (const c of await liveUnwritten([...stored.keys()])) live.get(c.issueId)?.push(c);
  const after = await marksOn(ex, [...stored.keys()]);
  return [...stored]
    .filter(([id]) => !after.has(id))
    .flatMap(([issueId, criteria]) => {
      const now = JSON.parse(JSON.stringify(live.get(issueId) ?? [])) as unknown;
      return criteria !== null && canonical(criteria) === canonical(now)
        ? []
        : [{ issueId, stored: criteria, live: now }];
    })
    .sort((a, b) => a.issueId.localeCompare(b.issueId));
}

/**
 * Issues the drift sweep weighs each pass: the newest verdicts' issues, and as many at random. The
 * random ones are drawn row by row (`ORDER BY random()`, one row per issue): a page sample
 * (`TABLESAMPLE SYSTEM`) of a table a few pages long draws nothing on most passes.
 */
const SWEEP_NEWEST = 100;
const SWEEP_RANDOM = 100;
/** Marked issues the sweep rewrites each pass, oldest first, so a mark no read reaches still ends. */
const SWEEP_DRAIN = 500;

export interface CriteriaFactSweep {
  drained: number;
  weighed: number;
  drift: CriteriaFactDrift[];
}

/**
 * The drift sweep (ISS-1070 r7): rewrites the oldest marks no read has reached, then weighs the model
 * against the live read for the issues with the newest verdicts and as many at random. A drift is an
 * input some write moved without its trigger marking the issue: it is logged as an error and
 * reported, and never repaired here, so the write that got past the trigger is found, not hidden.
 */
export async function sweepCriteriaFacts(ex: Executor = db): Promise<CriteriaFactSweep> {
  let drained = 0;
  while (drained < SWEEP_DRAIN) {
    const n = await drainStaleCriteriaFacts(ex, 200);
    drained += n;
    if (n === 0) break;
  }
  const sample = (await ex.execute(sql`
    (SELECT issue_id FROM criterion_verdicts GROUP BY issue_id ORDER BY max(created_at) DESC LIMIT ${SWEEP_NEWEST})
    UNION
    (SELECT issue_id FROM issue_criteria_facts ORDER BY random() LIMIT ${SWEEP_RANDOM})`)) as unknown as {
    issue_id: string;
  }[];
  const ids = sample.map((r) => r.issue_id);
  const drift = await criteriaFactDrift(ex, ids);
  if (drift.length > 0) {
    const extra = {
      drift: drift.slice(0, 5),
      issues: drift.map((d) => d.issueId).slice(0, 50),
      count: drift.length,
    };
    logger.error(extra, 'criteria-facts: the model holds criteria the live read no longer answers');
    reportCondition('criteria-facts: drift between issue_criteria_facts and the live read', {
      level: 'error',
      extra,
    });
  }
  return { drained, weighed: ids.length, drift };
}

/** The drift sweep as the cluster timer runs it (`timer-registry.ts`), every ten minutes. */
export async function criteriaFactsTick(): Promise<void> {
  const { drained, weighed, drift } = await sweepCriteriaFacts();
  if (drained > 0)
    logger.info({ drained, weighed, drifted: drift.length }, 'criteria-facts: swept');
}
