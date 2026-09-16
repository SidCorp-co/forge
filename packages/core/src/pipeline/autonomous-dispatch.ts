// Dispatch for a project running the agent-driven pipeline.
//
// The staged driver enqueues one job per status and lets the state machine
// walk the issue. The autonomous driver enqueues ONE job for the whole issue
// and then gets out of the way: the session owns every phase, so any later
// status change on that issue must produce no job at all.
//
// Nothing about run bookkeeping changes. An autonomous run is still
// `kind='issue'` with one open run per issue, because that kind is what the
// partial unique index, the issue-run reaper and the dispatch gates are keyed
// on — a new kind would mean a second copy of each, which is exactly the
// second orphan-hygiene mechanism this phase is not allowed to need.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
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
  projectCreatedBy: string | null;
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

/**
 * The human pressing "Run" on an issue an autonomous project has gated. Throws
 * `ActiveJobConflictError` when a drive job is already live, so the route 409s
 * exactly as the staged manual path does.
 */
export async function dispatchDriveManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  projectCreatedBy: string | null;
}): Promise<{ released: true }> {
  if (!autonomousStepFor(args.status)) {
    throw new Error(
      `AUTONOMOUS_NOT_AT_ENTRY: the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${args.status}\``,
    );
  }
  await db.execute(sql`
    UPDATE issues
    SET session_context = jsonb_set(
          COALESCE(session_context, '{}'::jsonb), ARRAY['runRelease'], to_jsonb(now()), true),
        updated_at = now()
    WHERE id = ${args.issueId}
  `);
  await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
  });
  logger.info(
    { projectId: args.projectId, issueId: args.issueId },
    'autonomous-dispatch: released by hand — offered to this project masters',
  );
  return { released: true };
}
