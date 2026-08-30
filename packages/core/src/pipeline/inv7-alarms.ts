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
// rather than from a status the driver never writes. The fifth is the third's
// blind spot: work queued behind a run that is PAUSED, which the third cannot
// see because such a job has a gate reason and the third tests for having none.
//
// Every pass here emits a wedge notification and touches no state at all.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { gateReasonsForQueuedJobs } from '../jobs/dispatch-gates.js';
import { HOLD_PAYLOAD_KEY, holdResumesItself } from '../jobs/hold.js';
import { RESULT_QUIET_MINUTES } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { DEFAULT_NO_PROGRESS_ROUNDS } from './reopen-policy.js';
import { pauseResumesItself } from './run-pause.js';
import {
  emitPipelineWedge,
  pausedRunWedgeEntityId,
  resolvePipelineWedge,
  reviewRoundsWedgeEntityId,
} from './wedge.js';

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

interface PausedRunRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  issue_id: string | null;
  pause_reason: string | null;
  paused_since: string;
  queued_jobs: number;
  queued_types: string;
  iss_seq: number | null;
}

/**
 * Rows one sweep will look at.
 */
// cm:guard the ORDER BY is what makes this cap safe, and it is NOT decoration — this pass writes no run state, so a row it processes does NOT leave the candidate set the way `reapOrphanedIssueRuns`' terminal rows do. Copy that pass's bare `LIMIT 200` without ordering frozen-work first and the cleanup arm eats the whole budget forever: measured against real Postgres, 200 zero-queue paused runs (which need nothing, and sort first under `updated_at ASC` alone) plus one run with a genuinely queued step gave alerted=0, resolves=200, and the one run that needed a human was never alarmed — every minute, permanently, with `alerted` reading 0 exactly as it does when all is well.
export const PAUSED_RUN_SCAN_LIMIT = 200;

/** How long a pause may hold work back before it is worth a human's attention. */
export const PAUSED_RUN_ALARM_MS = (() => {
  const raw = Number(process.env.FORGE_PAUSED_RUN_ALARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : HOLD_AGE_ALARM_MS;
})();

/**
 * Steps queued behind a pause nobody is being told about.
 */
// cm:guard scoped to `paused` runs and nothing else — a `queued` job under a RUNNING run is either explained by a gate that already has an owner (`detectStalledDependencies`, `alarmAgedHolds`, `alarmUnrunnableBlockedDependents`) or by none, which is `alarmStalledQueuedJobs`. Widening this to `running` would double-notify all of them, and would re-open the age-based-reaper shape a human rejected on ISS-765 (2026-08-11) because a job legitimately queued behind the project cap is byte-identical to an orphan. Under a paused run there is no such reading: the picker requires `r.status='running'`, so nothing behind the pause can start, whatever its age.
// cm:guard alarm ONLY (RFC 0002 INV-7) — never resume the run, cancel the job or re-dispatch. `missing_skill` resumes itself the moment the skill is registered and `reEnqueueForIssue` re-fires the work, so cancelling here would destroy exactly what the resume exists to rescue; `stage_stalled` and an operator pause are decisions only a person can revisit.
// cm:edge lockstep -> packages/core/src/pipeline/paused-run-wedge-resolve.ts — that subscriber clears what this emits; the pair is what stops the daily re-notify outliving the pause
export async function alarmPausedRunsWithQueuedWork(
  now: Date = new Date(),
): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - PAUSED_RUN_ALARM_MS).toISOString();
  // cm:guard `updated_at` is a PROXY for "paused since" and a LOSSY one — nothing stores the pause timestamp, and `setCurrentStepForOpenIssueRun` (issues/apply-transition.ts) stamps it on a `paused` run at EVERY issue transition. So an operator repeatedly clicking "open" on a wedged issue — the exact behaviour in the ISS-576/652 incident — pushes this clock forward each time and can defer the alarm indefinitely. Do not read the delay as harmless; the honest fix is a stored `pausedAt` on the run, and this predicate should move to it rather than be tightened.
  // cm:guard write `metadata` LITERALLY, never as a Drizzle column reference — inside a raw `sql` template Drizzle renders the reference unqualified, which collides across the joined tables and fails at parse time
  const rows = await db.execute<PausedRunRow>(sql`
    SELECT r.id AS run_id,
           r.project_id,
           r.issue_id,
           r.metadata ->> 'pauseReason' AS pause_reason,
           r.updated_at AS paused_since,
           count(j.id)::int AS queued_jobs,
           string_agg(DISTINCT j.type, ', ') AS queued_types,
           i.iss_seq
    FROM pipeline_runs r
    LEFT JOIN jobs j ON j.pipeline_run_id = r.id AND j.status = 'queued'
    LEFT JOIN issues i ON i.id = r.issue_id
    WHERE r.status = 'paused'
      AND r.updated_at < ${cutoffIso}
    GROUP BY r.id, i.iss_seq
    ORDER BY (count(j.id) = 0) ASC, r.updated_at ASC
    LIMIT ${PAUSED_RUN_SCAN_LIMIT}
  `);

  const hours = Math.round(PAUSED_RUN_ALARM_MS / 3_600_000);
  let alerted = 0;
  for (const row of rows) {
    const label = row.iss_seq ? `ISS-${row.iss_seq}` : 'A pipeline run';
    const steps = Number(row.queued_jobs);
    // cm:guard the LEFT JOIN returns paused runs with ZERO queued jobs on purpose, so this pass clears its own notification when the queue behind the pause empties. The run leaving `paused` is not the only way the condition ends — an operator can cancel the queued steps and leave the pause standing — and the subscriber only watches the run. Without this arm the bell keeps a row asserting N frozen steps when there are none.
    if (steps === 0) {
      await resolvePipelineWedge(pausedRunWedgeEntityId(row.run_id));
      continue;
    }
    alerted++;
    // cm:guard ask `pauseResumesItself`, never assume from the reason string — only `missing_skill` has a resume path (`missing-skill-resume.ts`), `stage_stalled` has none anywhere in the repo, and an operator pause is a human's decision. This wedge is the operator's only recurring notification for a frozen queue; telling them "it resumes on its own" about a pause that never will is the aged-hold failure repeated on the run axis.
    const selfResuming = pauseResumesItself(row.pause_reason);
    const cause = row.pause_reason ?? 'an operator pause (no machine reason recorded)';
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'dispatch',
      entity: 'run',
      entityId: pausedRunWedgeEntityId(row.run_id),
      reason: `paused_over_${hours}h:${row.pause_reason ?? 'operator'}`,
      title: `${label} has ${steps} step${steps === 1 ? '' : 's'} frozen behind a paused run`,
      summary: `The pipeline run for ${label} has been paused since ${row.paused_since} (${cause}) and ${steps} step${steps === 1 ? '' : 's'} (${row.queued_types}) ${steps === 1 ? 'is' : 'are'} queued behind it. Queued work under a paused run cannot start — the picker only offers jobs whose run is \`running\` — and while it waits nothing can queue a replacement for the same step either.`,
      nextStep: selfResuming
        ? 'Fix the condition named above (register the missing skill, or turn the stage off) and the run resumes on its own, re-firing the queued work.'
        : 'This pause will NOT resume by itself. Decide what the run should do, then resume or cancel it from the run view — until one of those, the steps behind it stay frozen.',
      action: selfResuming
        ? 'Clear the named condition; the run restarts itself.'
        : 'The run is waiting on you, not on a machine.',
    });
  }

  if (alerted > 0) {
    logger.info({ alerted, paused: rows.length }, 'inv7: paused runs with frozen work surfaced');
  }
  // cm:guard say it when the scan is truncated — a capped sweep and a quiet one both report `alerted: 0` for the rows they never read, and a silent alarm is the failure this pass exists to end
  // cm:why a log and not a wedge, which is a real weakness in a pass whose whole premise is that logs were not enough: the cap is GLOBAL and this query takes no project scope, so a truncated sweep has no single owner to notify. Reaching it needs 200 simultaneous frozen-work paused runs, a state in which 200 wedges are already in someone's bell. If it ever fires in production the answer is a wedge about the cap itself, not a bigger number.
  if (rows.length >= PAUSED_RUN_SCAN_LIMIT) {
    logger.warn(
      { limit: PAUSED_RUN_SCAN_LIMIT, alerted },
      'inv7: paused-run scan hit its row cap — runs beyond it were not examined this sweep',
    );
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
