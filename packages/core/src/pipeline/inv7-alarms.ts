// Passes that WATCH and write nothing.
//
// Two came from RFC 0002 INV-7: a held job whose condition never clears, and an
// issue reopening round after round. Neither is fixable by a status write — the
// mechanical park told a human "your turn" when nothing was being asked, and the
// reopen cap parked issues that were making progress. The third, a job queued
// with every gate passing, is the same shape from the other direction: nothing
// is wrong with the row, so there is nothing to reap. The fourth watches the
// same churn as the second on the axis autonomous mode actually moves: a review
// loop going round without landing, counted from the reviewer's own verdicts
// rather than from a status the driver never writes.
//
// Every pass here emits a wedge notification and touches no state at all.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { gateReasonsForQueuedJobs } from '../jobs/dispatch-gates.js';
import { HOLD_PAYLOAD_KEY, holdResumesItself } from '../jobs/hold.js';
import { RESULT_QUIET_MINUTES } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { DEFAULT_NO_PROGRESS_ROUNDS } from './reopen-policy.js';
import { emitPipelineWedge, reviewRoundsWedgeEntityId } from './wedge.js';

export interface Inv7AlarmResult {
  alerted: number;
}

/** How long a hold may sit before it is worth a human's attention. */
export const HOLD_AGE_ALARM_MS = (() => {
  const raw = Number(process.env.FORGE_HOLD_AGE_ALARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60_000;
})();

interface AgedHoldRow extends Record<string, unknown> {
  job_id: string;
  project_id: string;
  issue_id: string | null;
  job_type: string;
  hold_reason: string | null;
  held_at: string | null;
  iss_seq: number | null;
}

/**
 * Holds older than `HOLD_AGE_ALARM_MS`, surfaced once each.
 */
// cm:guard alarm ONLY — this pass must never write a status, cancel the job, or release the hold (RFC 0002 INV-7). An aged hold is honest: the step cannot run and nobody is pretending otherwise. Releasing it here would re-dispatch into the same failure the hold recorded, and cancelling it would delete the record of why the work stopped.
export async function alarmAgedHolds(now: Date = new Date()): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - HOLD_AGE_ALARM_MS).toISOString();
  // cm:guard write `payload` LITERALLY, never as a Drizzle column reference — inside a raw `sql` template Drizzle renders the reference unqualified, which collides with `issues` in the join and fails at parse time
  const rows = await db.execute<AgedHoldRow>(sql`
    SELECT j.id AS job_id,
           j.project_id,
           j.issue_id,
           j.type AS job_type,
           j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'reason' AS hold_reason,
           j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'heldAt' AS held_at,
           i.iss_seq
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    WHERE j.status = 'held'
      AND (j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'heldAt') < ${cutoffIso}
  `);

  for (const row of rows) {
    const label = row.iss_seq ? `ISS-${row.iss_seq}` : 'A step';
    const hours = Math.round(HOLD_AGE_ALARM_MS / 3_600_000);
    // cm:guard ask `holdResumesItself`, never assume — three of the five hold reasons never self-release, and this wedge is the operator's ONLY notification for a hold. Telling them "it resumes on its own" about a permanent hold is how a step sat for weeks with everyone believing it was handled.
    const selfResuming = holdResumesItself(row.hold_reason);
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'dispatch',
      entity: 'job',
      entityId: row.job_id,
      reason: `held_over_${hours}h:${row.hold_reason ?? 'unknown'}`,
      title: `${label} has been waiting on a machine for over ${hours}h`,
      summary: `The \`${row.job_type}\` step could not run (${row.hold_reason ?? 'unknown reason'}) and has been held since ${row.held_at ?? 'an unknown time'}. The issue itself was never moved — it is still at its stage, and no decision is being asked of anyone.`,
      // cm:guard the order in this sentence is load-bearing — a held job occupies L1 `issueBusyJob` (and `jobs_active_unique` covers `held`), so moving the issue on FIRST cannot produce a replacement step. Cancel, then move.
      nextStep: selfResuming
        ? 'Fix the underlying condition (a runner, a quota, a budget) and the step resumes on its own. If the condition is permanent, cancel the step.'
        : 'This hold will NOT clear by itself. Fix the underlying cause, then cancel this step and move the issue on — in that order, because a held step blocks any replacement for the same issue.',
      action: selfResuming
        ? 'Clear the blocking condition; nothing needs doing on the issue.'
        : 'Fix the cause, then cancel the step; it is waiting on you, not on a machine.',
    });
  }

  if (rows.length > 0) {
    logger.info({ alerted: rows.length }, 'inv7: aged holds surfaced');
  }
  return { alerted: rows.length };
}

interface StalledQueuedRow extends Record<string, unknown> {
  job_id: string;
  project_id: string;
  issue_id: string | null;
  job_type: string;
  created_at: string;
  iss_seq: number | null;
}

/** How long a job may sit `queued` with nothing gating it before it is worth a human's attention. */
export const QUEUED_STALL_ALARM_MS = (() => {
  const raw = Number(process.env.FORGE_QUEUED_STALL_ALARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RESULT_QUIET_MINUTES * 60_000;
})();

/**
 * Jobs the dispatcher says it could run, that have not run.
 */
// cm:guard the test is ABSENCE from `gateReasonsForQueuedJobs`, and nothing else. A job the map explains — `runner_stale`, `runner_full`, `blocked_by`, `project_cap` — is queued for a reason and must stay silent: waiting for a runner is the normal state of a queue, and an alarm that fires on it is one operators learn to ignore. Only "the picker offers this job and it still has not moved" has no innocent reading; that is the picker-offers/selector-rejects deadlock, measured 2026-08-14 at 11 jobs queued 6-22 days across 5 projects with no surface able to say why.
// cm:guard alarm ONLY (RFC 0002 INV-7) — never cancel, re-queue or re-dispatch here. A plain `queued` job holds NO capacity (`running_ids` counts it only while `retry_after_at > now()`, and `issueBusyJob` only counts dispatched/running/held), so nothing is freed by killing it and a wrong reap deletes real work.
export async function alarmStalledQueuedJobs(now: Date = new Date()): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - QUEUED_STALL_ALARM_MS).toISOString();
  const rows = await db.execute<StalledQueuedRow>(sql`
    SELECT j.id AS job_id,
           j.project_id,
           j.issue_id,
           j.type AS job_type,
           j.created_at,
           i.iss_seq
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    LEFT JOIN issues i ON i.id = j.issue_id
    WHERE j.status = 'queued'
      AND pr.status = 'running'
      AND j.created_at < ${cutoffIso}
      AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
  `);
  if (rows.length === 0) return { alerted: 0 };

  const byProject = new Map<string, StalledQueuedRow[]>();
  for (const row of rows) {
    const bucket = byProject.get(row.project_id) ?? [];
    bucket.push(row);
    byProject.set(row.project_id, bucket);
  }

  const minutes = Math.round(QUEUED_STALL_ALARM_MS / 60_000);
  let alerted = 0;
  for (const [projectId, candidates] of byProject) {
    const gated = await gateReasonsForQueuedJobs(projectId);
    for (const row of candidates) {
      if (gated.has(row.job_id)) continue;
      const label = row.iss_seq ? `ISS-${row.iss_seq}` : 'A step';
      await emitPipelineWedge({
        projectId,
        issueId: row.issue_id,
        hop: 'dispatch',
        entity: 'job',
        entityId: row.job_id,
        reason: `queued_over_${minutes}m:no_gate`,
        title: `${label} has been ready to run for over ${minutes}m and has not started`,
        summary: `The \`${row.job_type}\` step has been queued since ${row.created_at} and every dispatch gate passes — no dependency, no busy issue, no project cap, and a runner is online with a free slot. The picker is offering this job to a selector that keeps declining it, so nothing in the pipeline will move this issue on its own.`,
        nextStep:
          "Compare the picker and the selector: a runner counted as available by the gate but filtered out by `selectRunnerForJob` produces exactly this. Check the runner's labels, capabilities and required device against what the job asks for.",
        action: 'Nothing is blocking it and nothing will start it — it needs you.',
      });
      alerted++;
    }
  }

  if (alerted > 0) {
    logger.info({ alerted, candidates: rows.length }, 'inv7: stalled queued jobs surfaced');
  }
  return { alerted };
}

interface ChurnRow extends Record<string, unknown> {
  issue_id: string;
  project_id: string;
  iss_seq: number;
  title: string;
  reopen_count: number;
  threshold: number;
}

/**
 * Issues whose `reopenCount` has reached the project's `noProgressRounds`.
 */
// cm:guard the notification must NOT claim the rounds were wasted (RFC 0002 INV-8) — a TOTAL of reopens cannot tell "five rounds, five different blockers fixed" (ISS-801) from "five rounds, nothing changed", and a wedge that asserts the second is the cap's judgement smuggled back in as copy
// cm:guard this pass sees STAGED projects only, and must not be "fixed" by widening the column — `reopen_count` moves solely on entry into `reopen` (issues/apply-transition.ts), a transition autonomous mode never performs, so on an autonomous project it is frozen at whatever staged mode left. Measured 2026-08-30: of 19 runs that went 5+ code rounds inside ONE autonomous run, 18 have reopen_count 0. `alarmRejectionStreaks` is that half; the two are complements, not duplicates.
export async function alarmChurningIssues(): Promise<Inv7AlarmResult> {
  const rows = await db.execute<ChurnRow>(sql`
    SELECT i.id AS issue_id,
           i.project_id,
           i.iss_seq,
           i.title,
           i.reopen_count,
           COALESCE(
             (p.agent_config -> 'pipelineConfig' -> 'reopenPolicy' ->> 'noProgressRounds')::int,
             ${DEFAULT_NO_PROGRESS_ROUNDS}
           ) AS threshold
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.status NOT IN ('closed', 'released', 'draft')
      AND i.reopen_count >= COALESCE(
            (p.agent_config -> 'pipelineConfig' -> 'reopenPolicy' ->> 'noProgressRounds')::int,
            ${DEFAULT_NO_PROGRESS_ROUNDS}
          )
  `);

  for (const row of rows) {
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'dispatch',
      entity: 'issue',
      entityId: row.issue_id,
      reason: `reopen_rounds:${row.reopen_count}/${row.threshold}`,
      title: `ISS-${row.iss_seq} has been reopened ${row.reopen_count} times`,
      summary: `"${row.title}" has reached this project's \`noProgressRounds\` (${row.threshold}) counted as TOTAL reopens. That is a number to look at, not a verdict: rounds that each fixed a different blocker are normal work. Read the issue's \`sessionContext.churn\` ledger — written by the agent — to see what each round changed.`,
      nextStep:
        'If the rounds are repeating the same failure with nothing new, park it at `waiting` with what has been tried. If they are progressing, no action.',
      action: 'Read the churn ledger and decide; nothing is blocked.',
    });
  }

  if (rows.length > 0) {
    logger.info({ alerted: rows.length }, 'inv7: churning issues surfaced');
  }
  return { alerted: rows.length };
}

interface RejectionStreakRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  issue_id: string;
  iss_seq: number | null;
  title: string | null;
  streak: number;
  threshold: number;
}

/**
 * Runs whose review loop has gone round `noProgressRounds` times without landing.
 */
// cm:guard scoped to a run still `running` — the alarm says a loop is going round RIGHT NOW, and `emitPipelineWedge` re-notifies every 24h on an unresolved key, so without this an issue parked after a streak would nag daily forever about a loop that ended. That shape put 721 unresolved wedges in the owner's bell on forge-beta 2026-08-14.
// cm:guard the streak is TRAILING — only rejections after the run's last `approve` count, and one approve resets it to zero. A longest-streak-anywhere variant alarms about churn that already ended, and the sweeper runs every minute, so the trailing form still reaches the threshold while it is happening.
// cm:guard `source = 'runner'` is what makes this a system record and is NOT an optimisation — the CHECK `phase_journal_verdict_is_runner_written` is the only thing stopping the driver authoring its own verdicts, so dropping this predicate would let the agent decide whether it is churning. `sessionContext.churn` is agent-written and is deliberately absent from the query; it is reading material for the human, named in the copy.
// cm:guard alarm ONLY (RFC 0002 INV-7/INV-8) — never park, cancel or cap. Nothing limits how many rounds an issue may take, and the round count is advice the reader judges; the deleted reopen cap is exactly what a status write here would rebuild.
// cm:edge contract -> packages/core/src/db/schema-journal.ts — reads `phase_journal.source`/`artifact->>'kind'`/`artifact->>'decision'` by name in raw SQL, so renaming a column or changing the verdict artifact shape silently empties this alarm instead of failing to compile
export async function alarmRejectionStreaks(): Promise<Inv7AlarmResult> {
  // cm:guard write `artifact` LITERALLY, never as a Drizzle column reference — inside a raw `sql` template Drizzle renders the reference unqualified, which collides across the joined tables and fails at parse time
  const rows = await db.execute<RejectionStreakRow>(sql`
    WITH verdicts AS (
      SELECT pj.run_id, pj.issue_id, pj.started_at, pj.artifact ->> 'decision' AS decision
      FROM phase_journal pj
      WHERE pj.source = 'runner' AND pj.artifact ->> 'kind' = 'verdict'
    ),
    last_approve AS (
      SELECT run_id, max(started_at) AS at FROM verdicts WHERE decision = 'approve' GROUP BY run_id
    )
    SELECT v.run_id,
           i.project_id,
           i.id AS issue_id,
           i.iss_seq,
           i.title,
           count(*)::int AS streak,
           COALESCE(
             (p.agent_config -> 'pipelineConfig' -> 'reopenPolicy' ->> 'noProgressRounds')::int,
             ${DEFAULT_NO_PROGRESS_ROUNDS}
           ) AS threshold
    FROM verdicts v
    LEFT JOIN last_approve la ON la.run_id = v.run_id
    JOIN pipeline_runs pr ON pr.id = v.run_id
    JOIN issues i ON i.id = v.issue_id
    JOIN projects p ON p.id = i.project_id
    WHERE v.decision = 'request_changes'
      AND (la.at IS NULL OR v.started_at > la.at)
      AND pr.status = 'running'
      AND i.status NOT IN ('closed', 'released', 'draft')
    GROUP BY v.run_id, i.project_id, i.id, i.iss_seq, i.title, p.id
    HAVING count(*) >= COALESCE(
             (p.agent_config -> 'pipelineConfig' -> 'reopenPolicy' ->> 'noProgressRounds')::int,
             ${DEFAULT_NO_PROGRESS_ROUNDS}
           )
  `);

  for (const row of rows) {
    const label = row.iss_seq ? `ISS-${row.iss_seq}` : 'An issue';
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'result',
      entity: 'run',
      entityId: reviewRoundsWedgeEntityId(row.run_id),
      reason: `rejection_streak:${row.streak}/${row.threshold}`,
      title: `${label} has been sent back by review ${row.streak} times in a row`,
      // cm:guard name the COUNT, not just the number — `noProgressRounds` backs two different counts (total reopens in `alarmChurningIssues`, consecutive rejections here), and a reader who cannot tell which one fired cannot tell whether the rounds were wasted
      summary: `"${row.title ?? label}" has reached this project's \`noProgressRounds\` (${row.threshold}) counted as CONSECUTIVE review rejections — ${row.streak} rounds since the last approval, from the reviewer's own verdicts rather than anything the driver reported about itself. Rounds that each fix a different blocker are normal work, and an approval resets this to zero; ${row.streak} in a row without one is the stop signal the number exists for.`,
      nextStep:
        "Read the findings on the last few `request_changes` verdicts. If they keep naming the same defect, park the issue at `waiting` with what has been tried; if each round names something new, no action. The agent's own `sessionContext.churn` ledger says what it believes changed each round.",
      action: 'Read the last rejections and decide; nothing is blocked.',
    });
  }

  if (rows.length > 0) {
    logger.info({ alerted: rows.length }, 'inv7: review rejection streaks surfaced');
  }
  return { alerted: rows.length };
}
