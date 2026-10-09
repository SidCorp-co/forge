import { type SQL, sql } from 'drizzle-orm';
import { deviceReach, fenceReaches, fenceWhere, type TokenFence } from '../credentials/token-fence.js';
import { db } from '../db/client.js';
import type { RefusalError } from '../lib/refusal.js';
import { refuseDevice } from './refusals.js';

const NON_ADMITTED_RUNNER_STATUSES = ['disabled', 'draining'] as const;

export const ADMITTED_RUNNER = sql`
  r.status NOT IN ('disabled', 'draining')
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL)
`;

/**
 * What this box's live credentials reach, read as the REST door reads a token (`credentials:tokenFence`):
 * an empty list reaches nothing, no list reaches everything (FB-78). An onboarding job drawn on a box
 * whose token answers 404 for its project fails every write and is retried as "reported nothing",
 * so only a box that reaches the project is offered one.
 */
async function boxReach(deviceId: string): Promise<TokenFence> {
  return (await deviceReach([deviceId]))(deviceId);
}

/** The pool's condition that an onboarding job `j` is on a project this box's credentials reach. */
export async function onboardingReachSql(deviceId: string): Promise<SQL> {
  const reached = fenceWhere(sql`j.project_id`, await boxReach(deviceId));
  return sql`(j.type <> 'onboarding' OR ${reached ?? sql`true`})`;
}

type RunnerAdmissionReason =
  | 'runner_withdrawn'
  | 'device_disabled'
  | 'runner_unbound'
  | 'token_cannot_reach';

type RunnerAdmission = { admitted: true } | { admitted: false; reason: RunnerAdmissionReason };

/** What every refusal ends on, so a box told no is also told what yes looks like. */
const ADMITTED_BOX =
  'An admitted box has a runner on this project whose status is online or offline, on a device that is not disabled.';

const WHAT_WAS_WRONG: Record<RunnerAdmissionReason, string> = {
  runner_unbound: 'this device has no runner on the project',
  device_disabled: 'this device is disabled',
  runner_withdrawn: "this device's runner on the project is disabled or draining",
  token_cannot_reach:
    "this device's credential does not reach the project, so an onboarding job there could not write a design",
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
    SELECT j.project_id, j.type FROM jobs j WHERE j.id = ${args.jobId} LIMIT 1
  `)) as unknown as Array<{ project_id: string | null; type: string }>;

  const job = rows[0];
  if (!job) return { admitted: true };
  if (job.project_id == null) return { admitted: false, reason: 'runner_unbound' };
  const admission = await projectAdmission({ projectId: job.project_id, deviceId: args.deviceId });
  if (
    admission.admitted &&
    job.type === 'onboarding' &&
    !fenceReaches(await boxReach(args.deviceId), job.project_id)
  ) {
    return { admitted: false, reason: 'token_cannot_reach' };
  }
  return admission;
}
