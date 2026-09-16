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
import { HOLD_PAYLOAD_KEY, holdResumesItself } from '../jobs/hold.js';
import { RESULT_QUIET_MINUTES } from '../jobs/loop-monitor.js';
import { gateReasonsForQueuedJobs } from '../jobs/queued-gates.js';
import { formatIssueRef } from '../lib/issue-ref.js';
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
  issue_prefix: string | null;
}

/**
 * Holds older than `HOLD_AGE_ALARM_MS`, surfaced once each.
 */
export async function alarmAgedHolds(now: Date = new Date()): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - HOLD_AGE_ALARM_MS).toISOString();
  const rows = await db.execute<AgedHoldRow>(sql`
    SELECT j.id AS job_id,
           j.project_id,
           j.issue_id,
           j.type AS job_type,
           j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'reason' AS hold_reason,
           j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'heldAt' AS held_at,
           i.iss_seq,
           p.issue_prefix
    FROM jobs j
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN projects p ON p.id = j.project_id
    WHERE j.status = 'held'
      AND (j.payload -> ${HOLD_PAYLOAD_KEY} ->> 'heldAt') < ${cutoffIso}
  `);

  for (const row of rows) {
    const label = row.iss_seq ? formatIssueRef(row.issue_prefix, row.iss_seq) : 'A step';
    const hours = Math.round(HOLD_AGE_ALARM_MS / 3_600_000);
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
  issue_prefix: string | null;
}

/** How long a job may sit `queued` with nothing gating it before it is worth a human's attention. */
export const QUEUED_STALL_ALARM_MS = (() => {
  const raw = Number(process.env.FORGE_QUEUED_STALL_ALARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RESULT_QUIET_MINUTES * 60_000;
})();

/**
 * Jobs the dispatcher says it could run, that have not run.
 */
export async function alarmStalledQueuedJobs(now: Date = new Date()): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - QUEUED_STALL_ALARM_MS).toISOString();
  const rows = await db.execute<StalledQueuedRow>(sql`
    SELECT j.id AS job_id,
           j.project_id,
           j.issue_id,
           j.type AS job_type,
           j.created_at,
           i.iss_seq,
           p.issue_prefix
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    LEFT JOIN issues i ON i.id = j.issue_id
    JOIN projects p ON p.id = j.project_id
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
      const label = row.iss_seq ? formatIssueRef(row.issue_prefix, row.iss_seq) : 'A step';
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
          "Compare the gate and the candidate query: a runner counted as available by the gate but filtered out by `onlineCapableDeviceIds` produces exactly this. Check the runner's labels, capabilities and required device against what the job asks for.",
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
  issue_prefix: string | null;
}

/**
 * Rows one sweep will look at.
 */
export const PAUSED_RUN_SCAN_LIMIT = 200;

/** How long a pause may hold work back before it is worth a human's attention. */
export const PAUSED_RUN_ALARM_MS = (() => {
  const raw = Number(process.env.FORGE_PAUSED_RUN_ALARM_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : HOLD_AGE_ALARM_MS;
})();

/**
 * Steps queued behind a pause nobody is being told about.
 */
export async function alarmPausedRunsWithQueuedWork(
  now: Date = new Date(),
): Promise<Inv7AlarmResult> {
  const cutoffIso = new Date(now.getTime() - PAUSED_RUN_ALARM_MS).toISOString();
  const rows = await db.execute<PausedRunRow>(sql`
    SELECT r.id AS run_id,
           r.project_id,
           r.issue_id,
           r.metadata ->> 'pauseReason' AS pause_reason,
           r.updated_at AS paused_since,
           count(j.id)::int AS queued_jobs,
           string_agg(DISTINCT j.type, ', ') AS queued_types,
           i.iss_seq,
           p2.issue_prefix
    FROM pipeline_runs r
    LEFT JOIN jobs j ON j.pipeline_run_id = r.id AND j.status = 'queued'
    LEFT JOIN issues i ON i.id = r.issue_id
    JOIN projects p2 ON p2.id = r.project_id
    WHERE r.status = 'paused'
      AND r.updated_at < ${cutoffIso}
    GROUP BY r.id, i.iss_seq, p2.issue_prefix
    ORDER BY (count(j.id) = 0) ASC, r.updated_at ASC
    LIMIT ${PAUSED_RUN_SCAN_LIMIT}
  `);

  const hours = Math.round(PAUSED_RUN_ALARM_MS / 3_600_000);
  let alerted = 0;
  for (const row of rows) {
    const label = row.iss_seq ? formatIssueRef(row.issue_prefix, row.iss_seq) : 'A pipeline run';
    const steps = Number(row.queued_jobs);
    if (steps === 0) {
      await resolvePipelineWedge(pausedRunWedgeEntityId(row.run_id));
      continue;
    }
    alerted++;
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
  if (alerted >= PAUSED_RUN_SCAN_LIMIT) {
    logger.warn(
      { limit: PAUSED_RUN_SCAN_LIMIT, alerted },
      'inv7: paused-run scan filled its cap with frozen work — runs beyond it were not examined',
    );
  }
  return { alerted };
}

interface RejectionStreakRow extends Record<string, unknown> {
  run_id: string;
  project_id: string;
  issue_id: string;
  iss_seq: number | null;
  issue_prefix: string | null;
  title: string | null;
  streak: number;
  threshold: number;
}

/**
 * Runs whose review loop has gone round `noProgressRounds` times without landing.
 */
export async function alarmRejectionStreaks(): Promise<Inv7AlarmResult> {
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
           p.issue_prefix,
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
      AND i.status NOT IN ('closed', 'awaiting_release', 'draft')
    GROUP BY v.run_id, i.project_id, i.id, i.iss_seq, i.title, p.id, p.issue_prefix
    HAVING count(*) >= COALESCE(
             (p.agent_config -> 'pipelineConfig' -> 'reopenPolicy' ->> 'noProgressRounds')::int,
             ${DEFAULT_NO_PROGRESS_ROUNDS}
           )
  `);

  for (const row of rows) {
    const label = row.iss_seq ? formatIssueRef(row.issue_prefix, row.iss_seq) : 'An issue';
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'result',
      entity: 'run',
      entityId: reviewRoundsWedgeEntityId(row.run_id),
      reason: `rejection_streak:${row.streak}/${row.threshold}`,
      title: `${label} has been sent back by review ${row.streak} times in a row`,
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
