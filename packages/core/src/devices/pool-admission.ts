import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { RefusalError } from '../lib/refusal.js';
import { refuseDevice } from './refusals.js';

export const NON_ADMITTED_RUNNER_STATUSES = ['disabled', 'draining'] as const;

export const ADMITTED_RUNNER = sql`
  r.status NOT IN ('disabled', 'draining')
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL)
`;

export type RunnerAdmissionReason = 'runner_withdrawn' | 'device_disabled' | 'runner_unbound';

export type RunnerAdmission =
  | { admitted: true }
  | { admitted: false; reason: RunnerAdmissionReason };

/** What every refusal ends on, so a box told no is also told what yes looks like. */
export const ADMITTED_BOX =
  'An admitted box has a runner on this project whose status is online or offline, on a device that is not disabled.';

const WHAT_WAS_WRONG: Record<RunnerAdmissionReason, string> = {
  runner_unbound: 'this device has no runner on the project',
  device_disabled: 'this device is disabled',
  runner_withdrawn: "this device's runner on the project is disabled or draining",
};

/** Refused before anything is written, so the box is told why rather than shown fewer rows. */
export function runnerNotAdmitted(args: {
  reason: RunnerAdmissionReason;
  projectId: string;
  deviceId: string;
}): RefusalError {
  return refuseDevice(
    'RUNNER_NOT_ADMITTED',
    `${args.reason}: ${WHAT_WAS_WRONG[args.reason]} (project ${args.projectId}, device ${args.deviceId}), ` +
      `so it may not open a run session there. ${ADMITTED_BOX}`,
  );
}

/**
 * Whether this device may take work on this project.
 *
 * Answers by name so the refusal reaches the master's transcript: a box that
 * has gone quiet is an operator's question, and "no reason given" is the state
 * this refuses to produce. `runners_project_device_type_uq` over the one runner
 * type makes the row this reads unique.
 */
export async function projectAdmission(args: {
  projectId: string;
  deviceId: string;
}): Promise<RunnerAdmission> {
  const rows = (await db.execute(sql`
    SELECT r.id AS runner_id, r.status,
           (SELECT d.disabled_at FROM devices d WHERE d.id = ${args.deviceId}) AS device_disabled_at
    FROM (SELECT 1) AS one
    LEFT JOIN runners r ON r.project_id = ${args.projectId} AND r.device_id = ${args.deviceId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row || row.runner_id == null) return { admitted: false, reason: 'runner_unbound' };
  if (row.device_disabled_at != null) return { admitted: false, reason: 'device_disabled' };
  if (NON_ADMITTED_RUNNER_STATUSES.includes(row.status as never)) {
    return { admitted: false, reason: 'runner_withdrawn' };
  }
  return { admitted: true };
}

/** `projectAdmission`, reached through the job's project. */
export async function runnerAdmission(args: {
  jobId: string;
  deviceId: string;
}): Promise<RunnerAdmission> {
  const rows = (await db.execute(sql`
    SELECT j.project_id FROM jobs j WHERE j.id = ${args.jobId} LIMIT 1
  `)) as unknown as Array<{ project_id: string | null }>;

  const job = rows[0];
  if (!job) return { admitted: true };
  if (job.project_id == null) return { admitted: false, reason: 'runner_unbound' };
  return projectAdmission({ projectId: job.project_id, deviceId: args.deviceId });
}
