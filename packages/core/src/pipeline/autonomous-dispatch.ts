import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, terminalAgentSessionStatuses } from '../db/schema.js';
import { statusForCaller } from '../issues/status-sets.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { logger } from '../logger.js';
import { wakeMastersForProject } from '../ws/master-wake.js';
import type { Actor } from './activity.js';
import { AUTONOMOUS_ENTRY_STATUS, autonomousStepFor, isAutonomous } from './autonomous-mode.js';
import type { PipelineConfig } from './pipeline-config-schema.js';

export {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_JOB_TYPE,
  AUTONOMOUS_SKILL_NAME,
  autonomousStepFor,
  isAutonomous,
  isEntryGateClosed,
} from './autonomous-mode.js';

export interface DispatchAutonomousArgs {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  cfg: PipelineConfig | null;
}

/**
 * The operator's gate on the entry stage — the one place a project says "hold
 * this issue for a human" without disabling the pipeline outright.
 */

/**
 * Handle dispatch for an autonomous project. Returns `true` when this driver
 * owns the decision — including when the decision is to do nothing — so the
 * caller returns without walking the staged path.
 */
export async function dispatchAutonomous(args: DispatchAutonomousArgs): Promise<boolean> {
  if (!isAutonomous(args.cfg)) return false;
  if (!autonomousStepFor(args.status)) return true;
  logger.debug(
    { projectId: args.projectId, issueId: args.issueId, status: args.status },
    'autonomous-dispatch: no job minted — a master opens the run session for this issue',
  );
  return true;
}

/** Refused: no master runs on the project, so a press would be taken by nothing (ISS-1228). */
export class NoMasterRunningError extends Error {
  readonly code = 'NO_MASTER_RUNNING';
  constructor() {
    super(
      'No master is running on this project, so nothing would take this issue. A master runs on a box bound to this project: start one there, then press Run again.',
    );
    this.name = 'NoMasterRunningError';
  }
}

/** A box the wake did not reach reads the issue on its master's next pass; the room keeps nothing. */
export interface DriveRelease {
  released: boolean;
  masters: number;
  boxesReached: number;
}

const TERMINAL_SESSIONS = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

async function liveMasters(projectId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_sessions
     WHERE project_id = ${projectId}
       AND kind = ${MASTER_SESSION_KIND}
       AND status NOT IN (${TERMINAL_SESSIONS})
  `)) as unknown as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

/**
 * The human pressing "Run" on an issue at the entry status: it releases the issue past a closed entry
 * gate and wakes the project's boxes. Core mints no job, so where no master runs it is refused before
 * anything is written, rather than answered as though something will take the issue.
 */
export async function dispatchDriveManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  entryGated: boolean;
}): Promise<DriveRelease> {
  if (!autonomousStepFor(args.status)) {
    throw new Error(
      `AUTONOMOUS_NOT_AT_ENTRY: the driver is handed an issue at ${statusForCaller(AUTONOMOUS_ENTRY_STATUS)}, this one is at ${statusForCaller(args.status)}`,
    );
  }
  const masters = await liveMasters(args.projectId);
  if (masters === 0) throw new NoMasterRunningError();
  await db.execute(sql`
    UPDATE issues
    SET session_context = jsonb_set(
          COALESCE(session_context, '{}'::jsonb), ARRAY['runRelease'], to_jsonb(now()), true),
        updated_at = now()
    WHERE id = ${args.issueId}
  `);
  const wake = await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
  });
  logger.info(
    { projectId: args.projectId, issueId: args.issueId, masters, boxesReached: wake.delivered },
    'autonomous-dispatch: released by hand — offered to this project masters',
  );
  return { released: args.entryGated, masters, boxesReached: wake.delivered };
}
