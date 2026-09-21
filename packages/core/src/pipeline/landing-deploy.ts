import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import type { HooksBus } from './hooks.js';
import { resolveLatestIssueRunId, tryDispatchCoolifyRelease } from './release-coolify.js';

export const LANDED_STATUS: IssueStatus = 'developed';

export const LANDING_DEPLOY_SUBSCRIBER = 'landing-deploy';

async function landingDeployIsOn(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? null) as Record<string, unknown> | null;
  const pc = ac?.pipelineConfig as Record<string, unknown> | undefined;
  return pc?.enabled === true && pc?.deployOnLanding === true;
}

/**
 * ISS-1152 — arrival at `developed` is what asks for a deployment, so a landed
 * change is judgeable without an unrelated issue's release carrying it out. It
 * replaces a `jobCompleted` filter on `type === 'release'`, a job type no
 * producer creates. A project opts in with `deployOnLanding`, a live binding
 * still parks for a human, and anything that throws propagates so the outbox
 * redelivers rather than losing the deploy to a false "not opted in".
 */
export function registerLandedChangeDeploySubscriber(bus: HooksBus): void {
  bus.on(
    'transition',
    async (payload) => {
      if (payload.to !== LANDED_STATUS) return;
      if (!(await landingDeployIsOn(payload.projectId))) return;

      const runId = await resolveLatestIssueRunId(payload.issueId);
      if (!runId) {
        logger.error(
          { issueId: payload.issueId, projectId: payload.projectId },
          'landing deploy: the issue landed with no pipeline run, so there is nothing to stamp the deploy onto and no hold to witness it — refusing rather than dispatching blind',
        );
        return;
      }

      await tryDispatchCoolifyRelease({
        projectId: payload.projectId,
        issueId: payload.issueId,
        runId,
      });
    },
    { name: LANDING_DEPLOY_SUBSCRIBER },
  );
}
