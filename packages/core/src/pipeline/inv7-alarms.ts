// RFC 0002 INV-7 — the two things the deleted gates used to "handle" by
// stopping the pipeline are now only WATCHED.
//
// A held job whose condition never clears, and an issue reopening round after
// round, are both real problems. Neither is one a status write can fix: the
// mechanical park told a human "your turn" when nothing was being asked, and the
// reopen cap parked issues that were making progress. Both passes here emit a
// wedge notification and touch no state at all.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { HOLD_PAYLOAD_KEY } from '../jobs/hold.js';
import { logger } from '../logger.js';
import { DEFAULT_NO_PROGRESS_ROUNDS } from './reopen-policy.js';
import { emitPipelineWedge } from './wedge.js';

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
    await emitPipelineWedge({
      projectId: row.project_id,
      issueId: row.issue_id,
      hop: 'dispatch',
      entity: 'job',
      entityId: row.job_id,
      reason: `held_over_${hours}h:${row.hold_reason ?? 'unknown'}`,
      title: `${label} has been waiting on a machine for over ${hours}h`,
      summary: `The \`${row.job_type}\` step could not run (${row.hold_reason ?? 'unknown reason'}) and has been held since ${row.held_at ?? 'an unknown time'}. The issue itself was never moved — it is still at its stage, and no decision is being asked of anyone.`,
      nextStep:
        'Fix the underlying condition (a runner, a quota, a budget) and the step resumes on its own. If the condition is permanent, cancel the run.',
      action: 'Clear the blocking condition; nothing needs doing on the issue.',
    });
  }

  if (rows.length > 0) {
    logger.info({ alerted: rows.length }, 'inv7: aged holds surfaced');
  }
  return { alerted: rows.length };
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
// cm:guard the notification must NOT claim the rounds were wasted (RFC 0002 INV-8) — the count alone cannot tell "five rounds, five different blockers fixed" (ISS-801) from "five rounds, nothing changed", and a wedge that asserts the second is the cap's judgement smuggled back in as copy
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
      summary: `"${row.title}" has reached this project's \`noProgressRounds\` (${row.threshold}). That is a number to look at, not a verdict: rounds that each fixed a different blocker are normal work. Read the issue's \`sessionContext.churn\` ledger to see what each round changed.`,
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
