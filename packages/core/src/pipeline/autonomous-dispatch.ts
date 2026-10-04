import type { IssueStatus } from '../db/schema.js';
import { stampRunStarted } from '../issues/index.js';
import { logger } from '../observability/logger.js';
import type { Actor } from './activity.js';
import { AUTONOMOUS_ENTRY_STATUS, autonomousStepFor, isAutonomous } from './autonomous-mode.js';
import { refusePipeline } from './refuse.js';

export {
  AUTONOMOUS_ENTRY_STATUS,
  AUTONOMOUS_JOB_TYPE,
  AUTONOMOUS_SKILL_NAME,
  autonomousStepFor,
  isAutonomous,
  isEntryGateClosed,
} from './autonomous-mode.js';

import { type ProjectPolicy, wakeMastersForProject } from './ports.js';

export interface DispatchAutonomousArgs {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  policy: ProjectPolicy | null;
  projectCreatedBy: string | null;
}

/**
 * Handle dispatch for an autonomous project. Returns `true` when this driver
 * owns the decision — including when the decision is to do nothing — so the
 * caller returns without walking the staged path.
 */
export async function dispatchAutonomous(args: DispatchAutonomousArgs): Promise<boolean> {
  if (!isAutonomous(args.policy)) return false;
  if (!autonomousStepFor(args.status)) return true;
  logger.debug(
    { projectId: args.projectId, issueId: args.issueId, status: args.status },
    'autonomous-dispatch: no job minted — a master opens the run session for this issue',
  );
  return true;
}

/**
 * A person starting an entry issue on a manual-intake project. The first start's time is kept, so
 * a second press reports when the issue was started rather than restarting its clock.
 */
export async function dispatchDriveManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  projectCreatedBy: string | null;
}): Promise<{ startedAt: string }> {
  if (!autonomousStepFor(args.status)) {
    throw refusePipeline(
      'NOT_AT_ENTRY_STATUS',
      `the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${args.status}\``,
    );
  }
  const startedAt = await stampRunStarted(args.issueId);
  if (!startedAt) throw new Error(`issue ${args.issueId} vanished while it was being started`);
  await wakeMastersForProject({
    projectId: args.projectId,
    issueId: args.issueId,
    status: args.status,
  });
  logger.info(
    { projectId: args.projectId, issueId: args.issueId, startedAt },
    'autonomous-dispatch: started by a person — offered to this project masters',
  );
  return { startedAt };
}
