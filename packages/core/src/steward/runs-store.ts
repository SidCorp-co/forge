// The steward's run record (REQ-48 BC-1): one live run per item, insert-or-fold under the partial
// unique index and the subject's lock. A trigger arriving while the run is queued folds into it (its
// act joins `acts_to_run`, its event `events`, the start stays at the first event plus the debounce);
// one arriving while it runs waits in `follow_up`, and the run's end queues those acts as the next run,
// so no act is dropped.

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import {
  STEWARD_ACT_RUNTIME,
  STEWARD_ACTS,
  STEWARD_DEBOUNCE_MS,
  STEWARD_TRIGGER_ACT,
  type StandingSubject,
  type StewardAct,
  type StewardFailureKind,
  type StewardSkipReason,
  type StewardTrigger,
} from '@forge/contracts/steward';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { type StewardRunEvent, stewardRuns } from '../db/schema-steward-runs.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { lockXact } from '../lib/advisory-lock.js';

export type RunRow = typeof stewardRuns.$inferSelect;

/** The states of a run still to end: the item's one live run, which a trigger folds into. */
const LIVE = ['queued', 'running'] as const;

/** Distinct acts in `STEWARD_ACTS` order: the order a run takes them in. */
export function orderedActs(acts: Iterable<StewardAct>): StewardAct[] {
  const held = new Set(acts);
  return STEWARD_ACTS.filter((a) => held.has(a));
}

function withEvent(events: readonly StewardRunEvent[], event: StewardRunEvent): StewardRunEvent[] {
  return events.some((e) => e.outboxId === event.outboxId) ? [...events] : [...events, event];
}

export interface TriggerIn {
  projectId: string;
  subject: StandingSubject;
  trigger: StewardTrigger;
  /** The outbox event that carried it, and when that event was written. */
  outboxId: string;
  at: Date;
  /** The basis the trigger saw, where it carries one (the sweep's). */
  basis?: string | null;
}

export type Folded = { runId: string; into: 'new' | 'queued' | 'follow_up' };

/** Insert the subject's run, or fold the trigger into the live one; inside the delivery's transaction. */
export async function foldTrigger(tx: Tx, t: TriggerIn): Promise<Folded> {
  await lockXact(tx, 'stewardRun', `${t.subject.kind}:${t.subject.id}`);
  const act = STEWARD_TRIGGER_ACT[t.trigger];
  const event: StewardRunEvent = {
    trigger: t.trigger,
    outboxId: t.outboxId,
    at: t.at.toISOString(),
  };
  const [live] = await tx
    .select()
    .from(stewardRuns)
    .where(
      and(
        eq(stewardRuns.subjectKind, t.subject.kind),
        eq(stewardRuns.subjectId, t.subject.id),
        inArray(stewardRuns.state, [...LIVE]),
      ),
    )
    .limit(1);
  if (!live) {
    const [row] = await tx
      .insert(stewardRuns)
      .values({
        projectId: t.projectId,
        subjectKind: t.subject.kind,
        subjectId: t.subject.id,
        subjectKey: t.subject.key,
        trigger: t.trigger,
        events: [event],
        actsToRun: [act],
        basis: t.basis ?? null,
        notBefore: new Date(t.at.getTime() + STEWARD_DEBOUNCE_MS),
      })
      .returning({ id: stewardRuns.id });
    if (!row) throw new Error('steward: the run insert returned no row');
    return { runId: row.id, into: 'new' };
  }
  if (live.state === 'queued') {
    await tx
      .update(stewardRuns)
      .set({
        actsToRun: orderedActs([...live.actsToRun, act]),
        events: withEvent(live.events, event),
        basis: t.basis ?? live.basis,
      })
      .where(eq(stewardRuns.id, live.id));
    return { runId: live.id, into: 'queued' };
  }
  await tx
    .update(stewardRuns)
    .set({
      followUp: orderedActs([...live.followUp, act]),
      followUpEvents: withEvent(live.followUpEvents, event),
    })
    .where(eq(stewardRuns.id, live.id));
  return { runId: live.id, into: 'follow_up' };
}

const RUNNER_ACTS = STEWARD_ACTS.filter((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job');

/** Triggers a standing read raises (the sweep's backlog), which wait behind every handoff event's run. */
const STANDING_TRIGGERS: readonly StewardTrigger[] = ['standing.stuck', 'standing.changed'];

/**
 * The live steward job a runner act waits behind: queued, dispatched or held, for a run still live.
 * A job left over from a run that has ended holds nothing back.
 */
export const liveStewardJobOf = (projectRef: ReturnType<typeof sql>) => sql`
  EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.project_id = ${projectRef} AND j.type = 'steward'
       AND j.status IN (${sql.raw(LIVE_JOB_STATUSES.map((st) => `'${st}'`).join(', '))})
       AND EXISTS (
         SELECT 1 FROM steward_runs s
          WHERE s.id::text = j.payload ->> 'stewardRunId' AND s.state IN ('queued', 'running')))`;

/**
 * Claim at most `limit` queued runs whose start has come as `running`: a handoff event's run first,
 * then the standing's backlog, each oldest first, so a sweep's hundred runs never starve a filed
 * item. A run owing a runner act is left queued while its project has a steward job live. The pick
 * is materialized: an `IN (… LIMIT … SKIP LOCKED)` subquery the planner rescans claims past its
 * limit. A claim is not a start: `started_at` is stamped by `markStarted` when the run is taken up.
 */
export async function claimDueRuns(now: Date, limit: number): Promise<RunRow[]> {
  if (limit <= 0) return [];
  const runnerActs = sql.raw(`ARRAY[${RUNNER_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const standing = sql.raw(`ARRAY[${STANDING_TRIGGERS.map((t) => `'${t}'`).join(', ')}]::text[]`);
  const rows = (await db.execute(sql`
    WITH picked AS MATERIALIZED (
      SELECT r.id FROM steward_runs r
       WHERE r.state = 'queued' AND r.not_before <= ${sqlTimestamp(now)}
         AND NOT (r.acts_to_run && ${runnerActs} AND ${liveStewardJobOf(sql`r.project_id`)})
       ORDER BY (r.trigger = ANY(${standing})), r.not_before
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE steward_runs s SET state = 'running', started_at = NULL
      FROM picked WHERE s.id = picked.id AND s.state = 'queued'
    RETURNING s.id
  `)) as unknown as { id: string }[];
  if (rows.length === 0) return [];
  const claimed = await db
    .select()
    .from(stewardRuns)
    .where(
      inArray(
        stewardRuns.id,
        rows.map((r) => r.id),
      ),
    );
  // in the claim's own order, so a caller with fewer slots than runs takes the handoffs first
  const rank = (r: RunRow) => (STANDING_TRIGGERS.includes(r.trigger as StewardTrigger) ? 1 : 0);
  return claimed.sort((a, b) => rank(a) - rank(b) || a.notBefore.getTime() - b.notBefore.getTime());
}

/** Stamp the claimed run started, at the moment it is taken up. */
export async function markStarted(runId: string, at = new Date(), tx?: Tx): Promise<void> {
  await (tx ?? db)
    .update(stewardRuns)
    .set({ startedAt: at })
    .where(and(eq(stewardRuns.id, runId), eq(stewardRuns.state, 'running')));
}

export type RunEnd =
  | { state: 'done' }
  | { state: 'failed'; failure: string; kind: StewardFailureKind }
  | { state: 'skipped'; reason: StewardSkipReason };

/**
 * End a running run, and queue what arrived while it ran as the next run, due now: those triggers
 * already waited out their debounce behind this one.
 */
export async function endRun(runId: string, end: RunEnd, now = new Date()): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(stewardRuns).where(eq(stewardRuns.id, runId)).limit(1);
    if (!run) throw new Error(`steward: run ${runId} is gone`);
    await lockXact(tx, 'stewardRun', `${run.subjectKind}:${run.subjectId}`);
    const [ended] = await tx
      .update(stewardRuns)
      .set({
        state: end.state,
        endedAt: now,
        skipReason: end.state === 'skipped' ? end.reason : null,
        failure: end.state === 'failed' ? end.failure : null,
        failureKind: end.state === 'failed' ? end.kind : null,
      })
      .where(and(eq(stewardRuns.id, runId), inArray(stewardRuns.state, [...LIVE])))
      .returning();
    if (!ended || ended.followUp.length === 0) return null;
    const first = ended.followUpEvents[0];
    const [next] = await tx
      .insert(stewardRuns)
      .values({
        projectId: ended.projectId,
        subjectKind: ended.subjectKind,
        subjectId: ended.subjectId,
        subjectKey: ended.subjectKey,
        trigger: first?.trigger ?? ended.trigger,
        events: ended.followUpEvents,
        actsToRun: ended.followUp,
        notBefore: now,
      })
      .returning({ id: stewardRuns.id });
    return next?.id ?? null;
  });
}

/** Put a claimed run back in the queue, due after `delayMs`: its project's runner job is still live. */
export async function requeueRun(runId: string, delayMs: number): Promise<void> {
  await db
    .update(stewardRuns)
    .set({ state: 'queued', startedAt: null, notBefore: new Date(Date.now() + delayMs) })
    .where(and(eq(stewardRuns.id, runId), eq(stewardRuns.state, 'running')));
}

export async function stampRun(
  runId: string,
  set: Partial<Pick<RunRow, 'basis' | 'jobId' | 'turnId' | 'actsToRun'>> & { addTurns?: number },
): Promise<void> {
  const { addTurns, ...rest } = set;
  await db
    .update(stewardRuns)
    .set({ ...rest, ...(addTurns ? { turns: sql`${stewardRuns.turns} + ${addTurns}` } : {}) })
    .where(eq(stewardRuns.id, runId));
}

/** One run of the project by id, whatever its state; null where the project holds none. */
export async function runOfProject(projectId: string, runId: string): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(stewardRuns)
    .where(and(eq(stewardRuns.projectId, projectId), eq(stewardRuns.id, runId)))
    .limit(1);
  return row ?? null;
}

export async function runOfJob(jobId: string): Promise<RunRow | null> {
  const [row] = await db
    .select()
    .from(stewardRuns)
    .where(and(eq(stewardRuns.jobId, jobId), eq(stewardRuns.state, 'running')))
    .limit(1);
  return row ?? null;
}

const GATEWAY_ACTS = STEWARD_ACTS.filter((a) => STEWARD_ACT_RUNTIME[a] === 'gateway_turn');

/**
 * What the project's steward spent since `dayStart`, gateway turns and runner jobs started, plus
 * what each other run already taken up still owes: its gateway acts not yet turned, and its job not
 * yet started. Runs taken up at once so never spend past the budget between them.
 */
export async function spentSince(
  projectId: string,
  dayStart: Date,
  opts: { exceptRunId?: string; tx?: Tx } = {},
): Promise<{ gatewayTurns: number; runnerJobs: number }> {
  const gateway = sql.raw(`ARRAY[${GATEWAY_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const runner = sql.raw(`ARRAY[${RUNNER_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const except = opts.exceptRunId ?? '00000000-0000-0000-0000-000000000000';
  const [row] = rowsOf<{ turns: number; jobs: number }>(
    await (opts.tx ?? db).execute(sql`
      SELECT coalesce(sum(r.turns), 0)::int
             + coalesce(sum(CASE WHEN r.state = 'running' AND r.id <> ${except}::uuid
                 THEN greatest(cardinality(ARRAY(SELECT unnest(r.acts_to_run) INTERSECT SELECT unnest(${gateway}))) - r.turns, 0)
                 ELSE 0 END), 0)::int AS turns,
             count(r.job_id)::int
             + count(*) FILTER (WHERE r.state = 'running' AND r.id <> ${except}::uuid
                 AND r.job_id IS NULL AND r.acts_to_run && ${runner})::int AS jobs
        FROM steward_runs r
       WHERE r.project_id = ${projectId} AND r.started_at >= ${sqlTimestamp(dayStart)}`),
  );
  return { gatewayTurns: row?.turns ?? 0, runnerJobs: row?.jobs ?? 0 };
}

/**
 * Whether a run of `act` on the subject holds `basis`: the sweep starts nothing twice on one basis. A
 * run skipped for its budget or the steward being off never acted, so it does not count. A run a door
 * refused counts for as long as the basis holds, since the same act on the same standing earns the
 * same refusal; one whose turn or job did not finish counts for an hour, after which the sweep tries
 * again.
 */
export async function ranOnBasis(
  subject: StandingSubject,
  act: StewardAct,
  basis: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: stewardRuns.id })
    .from(stewardRuns)
    .where(
      and(
        eq(stewardRuns.subjectKind, subject.kind),
        eq(stewardRuns.subjectId, subject.id),
        eq(stewardRuns.basis, basis),
        sql`${act} = ANY(${stewardRuns.actsToRun})`,
        sql`(${stewardRuns.state} IN ('queued', 'running', 'done') OR (${stewardRuns.state} = 'failed' AND (${stewardRuns.failureKind} = 'refused' OR ${stewardRuns.endedAt} > now() - interval '1 hour')))`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The subject's runs, newest first. */
export async function runsOfSubject(projectId: string, key: string, limit = 50): Promise<RunRow[]> {
  return db
    .select()
    .from(stewardRuns)
    .where(and(eq(stewardRuns.projectId, projectId), eq(stewardRuns.subjectKey, key)))
    .orderBy(sql`${stewardRuns.queuedAt} DESC`)
    .limit(limit);
}

/** How long a run with no job may stay `running` before it is read as orphaned by a process that ended. */
const ORPHANED_AFTER_MS = 15 * 60_000;

/**
 * The running runs nothing will end by itself: a runner act whose job is over (a cancelled job sends
 * no event), and a gateway run its process died under.
 */
export async function runsToSettle(
  now: Date,
): Promise<{ run: RunRow; jobStatus: string | null }[]> {
  const rows = (await db.execute(sql`
    SELECT r.id, j.status AS job_status FROM steward_runs r
      LEFT JOIN jobs j ON j.id = r.job_id
     WHERE r.state = 'running'
       AND ((r.job_id IS NOT NULL AND j.status IN ('done', 'failed', 'cancelled'))
         OR (r.job_id IS NULL AND COALESCE(r.started_at, r.not_before) < ${sqlTimestamp(new Date(now.getTime() - ORPHANED_AFTER_MS))}))
     LIMIT 100
  `)) as unknown as { id: string; job_status: string | null }[];
  if (rows.length === 0) return [];
  const runs = await db
    .select()
    .from(stewardRuns)
    .where(
      inArray(
        stewardRuns.id,
        rows.map((r) => r.id),
      ),
    );
  const statusOf = new Map(rows.map((r) => [r.id, r.job_status]));
  return runs.map((run) => ({ run, jobStatus: statusOf.get(run.id) ?? null }));
}
