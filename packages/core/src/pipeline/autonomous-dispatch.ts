import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import type { PolicyDocument } from '../project-config/schema.js';
import { wakeMastersForProject } from '../ws/master-wake.js';
import type { Actor } from './activity.js';
import { AUTONOMOUS_ENTRY_STATUS, autonomousStepFor, isAutonomous } from './autonomous-mode.js';

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
  policy: PolicyDocument | null;
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
    throw new Error(
      `AUTONOMOUS_NOT_AT_ENTRY: the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${args.status}\``,
    );
  }
  const rows = (await db.execute(sql`
    UPDATE issues
    SET session_context = CASE
          WHEN session_context ? 'runRelease' THEN session_context
          ELSE jsonb_set(COALESCE(session_context, '{}'::jsonb), ARRAY['runRelease'], to_jsonb(now()), true)
        END,
        updated_at = CASE WHEN session_context ? 'runRelease' THEN updated_at ELSE now() END
    WHERE id = ${args.issueId}
    RETURNING session_context->>'runRelease' AS started_at
  `)) as unknown as Array<{ started_at: string }>;
  const startedAt = rows[0]?.started_at;
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
