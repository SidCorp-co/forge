import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { PolicyRefusedError } from '../project-config/dispatch-policy.js';
import { readEffectivePolicy } from '../project-config/effective.js';
import type { PolicyDocument } from '../project-config/schema.js';
import type { Actor } from './activity.js';
import {
  AUTONOMOUS_ENTRY_STATUS,
  dispatchAutonomous,
  dispatchDriveManual,
  isEntryGateClosed,
} from './autonomous-dispatch.js';
import type { HooksBus } from './hooks.js';

export type StartRefusalCode = 'INTAKE_NOT_MANUAL' | 'PROJECT_ARCHIVED';

/** Why a person's start on an issue changes nothing, named so the route can say it. */
export class StartRefusedError extends Error {
  constructor(
    readonly code: StartRefusalCode,
    readonly projectId: string,
  ) {
    super(
      code === 'INTAKE_NOT_MANUAL'
        ? `INTAKE_NOT_MANUAL: project ${projectId} has policy intake \`auto\`, so its masters take every issue at \`${AUTONOMOUS_ENTRY_STATUS}\` without a person starting it. Starting one by hand is only for a project whose policy says \`intake: { mode: "manual" }\`.`
        : `PROJECT_ARCHIVED: project ${projectId} is archived, so nothing dispatches there. Restore the project before starting its issues.`,
    );
    this.name = 'StartRefusedError';
  }
}

async function loadProjectPolicy(projectId: string): Promise<{
  policy: PolicyDocument | null;
  archived: boolean;
  projectCreatedBy: string | null;
}> {
  const [row] = await db
    .select({ createdBy: projects.createdBy, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return { policy: null, archived: false, projectCreatedBy: null };
  const projectCreatedBy = row.createdBy ?? null;
  if (row.archivedAt != null) return { policy: null, archived: true, projectCreatedBy };
  const held = await readEffectivePolicy(projectId);
  return { policy: held?.document ?? null, archived: false, projectCreatedBy };
}

/**
 * A person starting an issue on a project whose policy intake is `manual` (ISS-29). It OFFERS the
 * issue rather than minting work for it (ISS-933): the stamp is what admits the entry row to its
 * masters, and a master opens the run itself.
 */
export async function triggerPipelineStepManual(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<{ startedAt: string }> {
  const { policy, archived, projectCreatedBy } = await loadProjectPolicy(args.projectId);
  if (archived) throw new StartRefusedError('PROJECT_ARCHIVED', args.projectId);
  if (!policy) throw new PolicyRefusedError('POLICY_UNDECLARED', args.projectId, null);
  if (!isEntryGateClosed(policy)) throw new StartRefusedError('INTAKE_NOT_MANUAL', args.projectId);
  return dispatchDriveManual({ ...args, projectCreatedBy });
}

export async function reEnqueueForIssue(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  actor: Actor;
  reason: Record<string, unknown>;
}): Promise<void> {
  const { policy, archived, projectCreatedBy } = await loadProjectPolicy(args.projectId);
  if (archived) return;
  if (!policy) {
    logger.warn(
      { projectId: args.projectId, issueId: args.issueId, code: 'POLICY_UNDECLARED' },
      new PolicyRefusedError('POLICY_UNDECLARED', args.projectId, null).message,
    );
    return;
  }
  await dispatchAutonomous({ ...args, policy, projectCreatedBy });
}

/**
 * Subscribe the pipeline orchestrator to `transition` and `issueCreated`
 * hooks. Issue creation lands the issue in `open` without emitting a
 * `transition`, so covering the manual-creation path needs both.
 *
 * Register only in the main process boot block — it touches the DB and pg-boss.
 */
export function registerPipelineOrchestrator(bus: HooksBus): void {
  bus.on(
    'transition',
    async (payload) => {
      try {
        if (payload.to !== AUTONOMOUS_ENTRY_STATUS) return;
        await reEnqueueForIssue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.to,
          actor: payload.actor,
          reason: { transition: { from: payload.from, to: payload.to } },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId, to: payload.to },
          'orchestrator: transition handler failed',
        );
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );

  bus.on(
    'issueCreated',
    async (payload) => {
      try {
        await reEnqueueForIssue({
          projectId: payload.projectId,
          issueId: payload.issueId,
          status: payload.status,
          actor: payload.actor,
          reason: { created: true },
        });
      } catch (err) {
        logger.error(
          { err, issueId: payload.issueId },
          'orchestrator: issueCreated handler failed',
        );
        throw err;
      }
    },
    { name: 'pipeline-orchestrator' },
  );
}
