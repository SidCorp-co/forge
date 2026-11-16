// The steward's run record (REQ-48 BC-1): one live run per item, insert-or-fold under the partial
// unique index and the subject's lock. A trigger arriving while the run is queued folds into it (its
// act joins `acts_to_run`, its event `events`, the start stays at the first event plus the debounce);
// one arriving while it runs waits in `follow_up`, and the run's end queues those acts as the next run,
// so no act is dropped.

import {
  STEWARD_ACT_RUNTIME,
  STEWARD_ACTS,
  STEWARD_DEBOUNCE_MS,
  STEWARD_START_WITHIN_MS,
  STEWARD_TRIGGER_ACT,
  type StandingSubject,
  type StewardAct,
  type StewardFailureKind,
  type StewardLiveSkipReason,
  type StewardTrigger,
} from '@forge/contracts/steward';
import { and, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { type StewardRunEvent, stewardRuns } from '../db/schema-steward-runs.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { lockXact } from '../lib/advisory-lock.js';
import { NOT_AN_END_DOORS } from './acts-store.js';

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

/**
 * The acts a trigger owes. A handoff whose act is a runner job also owes the item's note, a gateway
 * turn, so its run starts within the bound while the project's one steward job is taken (ISS-618 c1:
 * FB-211 waited queued behind 16 filed items' triage jobs, one at a time, past 5 minutes).
 */
export function triggerActs(trigger: StewardTrigger): StewardAct[] {
  const act = STEWARD_TRIGGER_ACT[trigger];
  return STEWARD_ACT_RUNTIME[act] === 'runner_job' && !isSweepTrigger(trigger)
    ? orderedActs(['note', act])
    : [act];
}

/** When a trigger's run is due: after its debounce. */
const dueOf = (t: TriggerIn): Date => new Date(t.at.getTime() + STEWARD_DEBOUNCE_MS);

/** Insert the subject's run, or fold the trigger into the live one; inside the delivery's transaction. */
export async function foldTrigger(tx: Tx, t: TriggerIn): Promise<Folded> {
  await lockXact(tx, 'stewardRun', `${t.subject.kind}:${t.subject.id}`);
  const acts = triggerActs(t.trigger);
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
        actsToRun: acts,
        basis: t.basis ?? null,
        notBefore: dueOf(t),
      })
      .returning({ id: stewardRuns.id });
    if (!row) throw new Error('steward: the run insert returned no row');
    return { runId: row.id, into: 'new' };
  }
  if (live.state === 'queued') {
    // a handoff folded into a sweep's run makes it a handoff run, due on the handoff's own clock, so
    // it is claimed ahead of the sweep's backlog (`claimDueRuns`)
    const handoff = isSweepTrigger(live.trigger) && !isSweepTrigger(t.trigger);
    const due = dueOf(t);
    await tx
      .update(stewardRuns)
      .set({
        actsToRun: orderedActs([...live.actsToRun, ...acts]),
        events: withEvent(live.events, event),
        basis: t.basis ?? live.basis,
        ...(handoff
          ? { trigger: t.trigger, notBefore: due < live.notBefore ? due : live.notBefore }
          : {}),
      })
      .where(eq(stewardRuns.id, live.id));
    return { runId: live.id, into: 'queued' };
  }
  await tx
    .update(stewardRuns)
    .set({
      followUp: orderedActs([...live.followUp, ...acts]),
      followUpEvents: withEvent(live.followUpEvents, event),
    })
    .where(eq(stewardRuns.id, live.id));
  return { runId: live.id, into: 'follow_up' };
}

/** The acts a steward job runs: each needs a slot on its project's box (`slot-demand.ts`). */
export const RUNNER_ACTS = STEWARD_ACTS.filter((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job');

/** Triggers a standing read raises (the sweep's backlog), which wait behind every handoff event's run. */
export const STANDING_TRIGGERS: readonly StewardTrigger[] = ['standing.stuck', 'standing.changed'];

/** A run the sweep raised, which spends the sweep's share of the day; any other run is a handoff's. */
export const isSweepTrigger = (trigger: string): boolean =>
  STANDING_TRIGGERS.includes(trigger as StewardTrigger);

/**
 * How long a run waiting for its project's slot may wait for its job, by the act it owes, before it is
 * due one: a filed item's triage within BC-1's bound, a release follow-through within an hour. A slot
 * goes to the run due soonest (`jobDue`), so a triage filed while a release's follow-throughs drain
 * takes the next slot that frees, and a follow-through that has waited its hour goes ahead of any
 * triage filed after that. A run's due is fixed at its first trigger, so no run waits behind ones
 * that arrive after it is due: neither kind starves the other (ISS-596 c6: FB-650 waited queued
 * behind nine follow-throughs on forge's one slot until a person triaged it by hand).
 */
export const JOB_WAIT_ALLOWANCE_MS: Readonly<Partial<Record<StewardAct, number>>> = {
  triage_draft: STEWARD_START_WITHIN_MS,
  release_followthrough: 60 * 60_000,
};

/**
 * When the run owing a steward job is due its slot: its first trigger's time (its queueing where it
 * carries none) plus the least allowance of the runner acts it owes. A carried or requeued run keeps
 * its events, so its due never moves.
 */
function jobDue(alias: string) {
  const r = sql.raw(alias);
  const allowances = RUNNER_ACTS.map((act) => {
    const ms = JOB_WAIT_ALLOWANCE_MS[act];
    if (ms === undefined) throw new Error(`steward: the runner act ${act} has no wait allowance`);
    return sql.raw(
      `CASE WHEN '${act}' = ANY(${alias}.acts_to_run) THEN interval '${ms} milliseconds' END`,
    );
  });
  return sql`(coalesce((SELECT min((e ->> 'at')::timestamptz) FROM jsonb_array_elements(${r}.events) e),
                       ${r}.queued_at)
              + coalesce(LEAST(${sql.join(allowances, sql`, `)}), interval '0'))`;
}

/**
 * Claim at most `limit` queued runs whose start has come as `running`: a handoff event's run first,
 * then the standing's backlog, and within each a run owing a gateway turn ahead of one owing only a
 * job, the turns oldest first and the jobs by when each is due its slot (`jobDue`), so neither a
 * sweep's hundred runs nor jobs waiting for a slot starve a filed item's note. Whether a run's job
 * may start is its project's slot on the box, which `dispatch.ts:runOne` asks when it takes the run
 * up, never the claim; which of its runs takes a free slot is the head of its job line
 * (`nextInJobLine`). The pick is materialized: an `IN (… LIMIT … SKIP LOCKED)` subquery the planner
 * rescans claims past its limit. A claim is not a start: `started_at` is stamped by `markStarted`
 * when the run is taken up.
 */
export async function claimDueRuns(now: Date, limit: number): Promise<RunRow[]> {
  if (limit <= 0) return [];
  const standing = sql.raw(`ARRAY[${STANDING_TRIGGERS.map((t) => `'${t}'`).join(', ')}]::text[]`);
  const runnerActs = sql.raw(`ARRAY[${RUNNER_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const rows = (await db.execute(sql`
    WITH picked AS MATERIALIZED (
      SELECT r.id FROM steward_runs r
       WHERE r.state = 'queued' AND r.not_before <= ${sqlTimestamp(now)}
       ORDER BY (r.trigger = ANY(${standing})), (r.acts_to_run <@ ${runnerActs}),
                CASE WHEN r.acts_to_run <@ ${runnerActs} THEN ${jobDue('r')} END, r.not_before,
                r.queued_at
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE steward_runs s SET state = 'running', started_at = NULL
      FROM picked WHERE s.id = picked.id AND s.state = 'queued'
    RETURNING s.id, ${jobDue('s')}::text AS due
  `)) as unknown as { id: string; due: string }[];
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
  const dueOf = new Map(rows.map((r) => [r.id, new Date(r.due).getTime()]));
  const jobOnly = (r: RunRow) => r.actsToRun.every((a) => RUNNER_ACTS.includes(a));
  const rank = (r: RunRow) =>
    (STANDING_TRIGGERS.includes(r.trigger as StewardTrigger) ? 2 : 0) + (jobOnly(r) ? 1 : 0);
  const key = (r: RunRow) => (jobOnly(r) ? (dueOf.get(r.id) ?? 0) : 0);
  return claimed.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      key(a) - key(b) ||
      a.notBefore.getTime() - b.notBefore.getTime() ||
      a.queuedAt.getTime() - b.queuedAt.getTime(),
  );
}

/**
 * The project's run next in line for a free slot: of its live runs owing a runner act that no job was
 * started for, the one due soonest (`jobDue`). A run taken up is in the line while it takes its turns,
 * so the slot it will ask for is not taken by a run due later; one its process died under leaves the
 * line when it is read orphaned (`runsToSettle`), as it is settled.
 */
export async function nextInJobLine(
  projectId: string,
  now = new Date(),
): Promise<{ id: string; state: string } | null> {
  const runnerActs = sql.raw(`ARRAY[${RUNNER_ACTS.map((a) => `'${a}'`).join(', ')}]::text[]`);
  const orphaned = sqlTimestamp(new Date(now.getTime() - ORPHANED_AFTER_MS));
  const [head] = rowsOf<{ id: string; state: string }>(
    await db.execute(sql`
      SELECT r.id::text AS id, r.state FROM steward_runs r
       WHERE r.project_id = ${projectId} AND r.job_id IS NULL AND r.acts_to_run && ${runnerActs}
         AND (r.state = 'queued'
           OR (r.state = 'running' AND COALESCE(r.started_at, r.not_before) >= ${orphaned}))
       ORDER BY ${jobDue('r')}, r.queued_at, r.id
       LIMIT 1`),
  );
  return head ?? null;
}

/** Make a queued run due now: the head of its job line, a slot of its project being free for it. */
export async function callToFront(runId: string, now = new Date()): Promise<void> {
  await db
    .update(stewardRuns)
    .set({ notBefore: sql`least(${stewardRuns.notBefore}, ${sqlTimestamp(now)})` })
    .where(and(eq(stewardRuns.id, runId), eq(stewardRuns.state, 'queued')));
}

/**
 * Carry a running run's acts into the run its end queues, with the events that asked for them: a
 * check taken alone (`dispatch.ts:checkAlone`), or a runner act its project had no free slot for once
 * its turns were taken, which waits for one in the next run (`endRun`).
 */
export async function carryActs(runId: string, acts: readonly StewardAct[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(stewardRuns).where(eq(stewardRuns.id, runId)).limit(1);
    if (!run) throw new Error(`steward: run ${runId} is gone`);
    await lockXact(tx, 'stewardRun', `${run.subjectKind}:${run.subjectId}`);
    const events = [...run.events, ...run.followUpEvents].filter(
      (e, i, all) => all.findIndex((o) => o.outboxId === e.outboxId) === i,
    );
    await tx
      .update(stewardRuns)
      .set({
        actsToRun: run.actsToRun.filter((a) => !acts.includes(a)),
        followUp: orderedActs([...acts, ...run.followUp]),
        followUpEvents: events,
      })
      .where(and(eq(stewardRuns.id, runId), eq(stewardRuns.state, 'running')));
  });
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
  | { state: 'skipped'; reason: StewardLiveSkipReason };

/**
 * End a running run, and queue what arrived while it ran as the next run, due now: those triggers
 * already waited out their debounce behind this one. Acts the run carried for want of a free slot
 * are due at `followUpNotBefore` instead, unless a trigger arrived while it ran.
 */
export async function endRun(
  runId: string,
  end: RunEnd,
  now = new Date(),
  opts: { followUpNotBefore?: Date | null } = {},
): Promise<string | null> {
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
    const arrived = ended.followUpEvents.some(
      (e) => !ended.events.some((o) => o.outboxId === e.outboxId),
    );
    const due = opts.followUpNotBefore && !arrived ? opts.followUpNotBefore : now;
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
        notBefore: due,
      })
      .returning({ id: stewardRuns.id });
    return next?.id ?? null;
  });
}

/** Put a claimed run back in the queue, due after `delayMs`: its project has no free slot for its job. */
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

/**
 * Whether a run of `act` on the subject holds `basis`: the sweep starts nothing twice on one basis. A
 * run skipped for the steward being off never acted, so it does not count. A run a door
 * refused counts for as long as the basis holds, since the same act on the same standing earns the
 * same refusal; one whose turn or job did not finish counts for an hour, after which the sweep tries
 * again. A stuck diagnosis that finished counts only where it ended in an act, an ask, or why nobody
 * was asked (`diagnosis-end.ts`): one that ended on a note alone is diagnosed again (ISS-654), and
 * the diagnosis that follows ends so unless an ask or a decision already held the standing, which the
 * sweep bounds on its own (`sweep.ts:diagnosedEnough`, ISS-1100). `queuedAfter` counts only the
 * runs queued after it: a note written under facts core has since reworded is rewritten by a run
 * queued after it was written, never the run that wrote it (ISS-1044). A run skipped because its
 * subject's life ended counts for as long as the basis holds: the standing read still lists a dropped
 * requirement, and forge raised a note run on each of REQ-59, REQ-60 and REQ-61 every sweep, each
 * skipped `subject_ended` (about 750 from 2026-11-14 to -15).
 */
export async function ranOnBasis(
  subject: StandingSubject,
  act: StewardAct,
  basis: string,
  opts: { queuedAfter?: Date } = {},
): Promise<boolean> {
  const notAnEnd = sql.join(
    NOT_AN_END_DOORS.map((p) => sql`a.door NOT LIKE ${p}`),
    sql` AND `,
  );
  const ended =
    act === 'stuck_diagnosis'
      ? sql`EXISTS (SELECT 1 FROM steward_acts a WHERE a.run_id = ${stewardRuns.id} AND ${notAnEnd})`
      : sql`true`;
  const [row] = await db
    .select({ id: stewardRuns.id })
    .from(stewardRuns)
    .where(
      and(
        eq(stewardRuns.subjectKind, subject.kind),
        eq(stewardRuns.subjectId, subject.id),
        eq(stewardRuns.basis, basis),
        sql`${act} = ANY(${stewardRuns.actsToRun})`,
        opts.queuedAfter ? gt(stewardRuns.queuedAt, opts.queuedAfter) : undefined,
        sql`(${stewardRuns.state} IN ('queued', 'running') OR (${stewardRuns.state} = 'skipped' AND ${stewardRuns.skipReason} = 'subject_ended') OR (${stewardRuns.state} = 'done' AND ${ended}) OR (${stewardRuns.state} = 'failed' AND ((${stewardRuns.failureKind} = 'refused' AND ${ended}) OR ${stewardRuns.endedAt} > now() - interval '1 hour')))`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The failure a run the runaway guard refused ends with starts with this (`policy.ts:admitRun`). */
export const REPEATED_CODE = 'STEWARD_ACT_REPEATED';

/**
 * How many runs took `act` on the subject on `basis` since its runs last ended on another basis: done,
 * or failed (a door refused it, its turn or its job did not finish), a run the runaway guard refused
 * apart, since it took nothing. A skipped run took nothing either. The basis is what the steward
 * records of the item's standing on each run, so these are the repeats without a state change.
 */
export async function repeatsOnBasis(
  subject: { kind: string; id: string },
  act: StewardAct,
  basis: string,
): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM steward_runs r
       WHERE r.subject_kind = ${subject.kind} AND r.subject_id = ${subject.id}
         AND r.basis = ${basis} AND ${act} = ANY(r.acts_to_run)
         AND r.state IN ('done', 'failed')
         AND coalesce(r.failure, '') NOT LIKE ${`${REPEATED_CODE}%`}
         AND r.ended_at > coalesce((
           SELECT max(o.ended_at) FROM steward_runs o
            WHERE o.subject_kind = ${subject.kind} AND o.subject_id = ${subject.id}
              AND o.basis IS NOT NULL AND o.basis <> ${basis}
              AND o.state IN ('done', 'failed')), '-infinity'::timestamptz)`),
  );
  return row?.n ?? 0;
}

/**
 * How many stuck diagnoses of the subject on `basis` ended since `since`: done or failed, a turn spent
 * on each, or with `finished` only those whose turn finished (done, or failed on a door's refusal).
 * A run skipped, or one still live, is none.
 */
export async function diagnosesOnBasis(
  subject: StandingSubject,
  basis: string,
  since: Date,
  opts: { finished?: boolean } = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stewardRuns)
    .where(
      and(
        eq(stewardRuns.subjectKind, subject.kind),
        eq(stewardRuns.subjectId, subject.id),
        eq(stewardRuns.basis, basis),
        sql`'stuck_diagnosis' = ANY(${stewardRuns.actsToRun})`,
        opts.finished
          ? sql`(${stewardRuns.state} = 'done' OR (${stewardRuns.state} = 'failed' AND ${stewardRuns.failureKind} = 'refused'))`
          : inArray(stewardRuns.state, ['done', 'failed']),
        gte(stewardRuns.endedAt, since),
      ),
    );
  return row?.n ?? 0;
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
