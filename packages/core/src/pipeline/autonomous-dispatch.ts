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
// cm:guard only the two knobs that name a HUMAN decision belong here. The per-step `auto*` toggles (autoTriage, autoCode…) name stages this mode does not have, so reading one as "may the driver start" would invent a meaning the operator never set.
// cm:guard this is the ONLY entry gate since ISS-897 left one lane. `orchestrator.ts` used to re-apply the same two checks below the autonomous branch for the staged path, and a second copy is what let the two disagree about what "require a human" meant per project; every caller now reaches dispatch through `dispatchAutonomous`, so a check added here needs no twin and must not grow one.

/**
 * Handle dispatch for an autonomous project. Returns `true` when this driver
 * owns the decision — including when the decision is to do nothing — so the
 * caller returns without walking the staged path.
 */
// cm:guard `true` on every status of an autonomous project, not just the entry one: falling through to the staged resolver at any other status would pause the run with a missing-skill comment the moment the agent moved its own issue.
// cm:guard core mints NOTHING for an autonomous project since ISS-933 — no `pipeline_run`, no `jobs` row. `drive` reaches a box as a run session the master opens itself, and a mint here would be the second live path this wave exists to remove: core's job and the box's run would both claim the same issue, with the ledger able to see only one of them.
// cm:edge lockstep -> packages/core/src/devices/admissible.ts — the entry status becomes admissible there INSTEAD of a job being minted here, and `isEntryGateClosed` is what both consult. Drop one half and the project either stalls with nothing to pick up, or starts work a human was meant to release.
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
// cm:guard this bypasses `isEntryGateClosed` ON PURPOSE and must keep doing so — "Run" IS the human the gate is waiting for, and a button that refuses because a human is required would make `mode: 'manual'` a dead end with no way out but editing the config
// cm:guard a human's Run OFFERS the issue and mints nothing. Minting here would be the second live path: core's job and the box's run session both claiming one issue, with the box ledger able to see only one of them (ISS-933 criterion 4).
// cm:edge lockstep -> packages/core/src/devices/admissible.ts — `runRelease` is read there as an OR beside the project gate; a stamp written here that nothing reads is a Run button that reports success and releases nothing.
export async function dispatchDriveManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  projectCreatedBy: string | null;
}): Promise<{ awaiting_release: true }> {
  if (!autonomousStepFor(args.status)) {
    throw new Error(
      `AUTONOMOUS_NOT_AT_ENTRY: the driver is handed an issue at \`${AUTONOMOUS_ENTRY_STATUS}\`, this one is at \`${args.status}\``,
    );
  }
  // cm:guard `jsonb_set`, never a whole-object write — `session_context` also carries the driver's `lease` and `worklog`, and a replace here drops whichever the running agent had just written, the same clobber shape `forge_config` states are already known for.
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
  return { awaiting_release: true };
}
