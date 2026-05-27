/**
 * ISS-242 — Action-dispatcher MCP tool `forge_coolify_deploy` that the stock
 * pipeline skills (forge-release / forge-staging / forge-code / forge-fix /
 * forge-test) already call but which had no server-side implementation,
 * causing a tool-not-found at the deploy step.
 *
 * Actions:
 *  - `list`   — active Coolify integrations for the project; drives the
 *               skills' "local-only mode" detection (empty array → no Coolify).
 *  - `deploy` — enqueue a Coolify deploy for the issue's latest run. Reuses the
 *               EXACT dispatch path the release auto-subscriber uses
 *               (`tryDispatchCoolifyRelease` → `enqueueCoolifyDispatch`,
 *               `requestId = ${runId}:${integrationId}`) so the agent-driven
 *               and auto paths DEDUPE instead of double-deploying. There is no
 *               parallel deploy path. Requires `issueId` because MCP carries no
 *               run context (only `X-Forge-Project-Slug`).
 *  - `status` — latest outbound delivery (deployment_uuid / ok|failed|pending /
 *               breaker) per integration, or for a specific `integrationId`.
 *
 * Authorization is membership-level (`assertPrincipalIsMember`) like
 * `forge_issues`; prod safety is the human-confirm gate inside
 * `tryDispatchCoolifyRelease`, not RBAC. No DEVICE_REQUIRED entry — the tool
 * has no runner dependency.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { projectIntegrations } from '../../db/schema.js';
import { findLastOutbound } from '../../integrations/deliveries.js';
import type { CoolifyConfig } from '../../integrations/coolify/types.js';
import { resolveLatestIssueRunId, tryDispatchCoolifyRelease } from '../../pipeline/release-coolify.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'deploy', 'status']),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

async function resolveProjectId(input: Input, projectSlug: string | null): Promise<string> {
  if (input.projectId) return input.projectId;
  return resolveProjectIdFromSlug(projectSlug);
}

/** Active Coolify integration rows for a project (mirrors the dispatch query). */
async function activeCoolifyIntegrations(projectId: string) {
  return db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.provider, 'coolify'),
        eq(projectIntegrations.active, true),
      ),
    );
}

export const forgeCoolifyDeployTool: ContextScopedMcpToolFactory = ({ principal, projectSlug }) => ({
  name: 'forge_coolify_deploy',
  description:
    'Coolify deploy controls for the pipeline skills. Actions: list | deploy | status. ' +
    'list: active Coolify integrations for the project (id, environment, resourceUuid, ' +
    'lastHealthStatus, breakerOpen); empty array => project is local-only (no Coolify). ' +
    'deploy: requires issueId — resolves the issue\'s latest pipeline run and enqueues a ' +
    'deploy via the SAME idempotent path as the release auto-subscriber (requestId = ' +
    'runId:integrationId), so a second deploy for the same run is a no-op (no double-deploy). ' +
    'prod integrations honor the human-confirm gate: returns pendingHumanConfirm:true and does ' +
    'NOT dispatch until confirmed via the confirm-prod-deploy endpoint. ' +
    'status: latest outbound delivery per integration (or a specific integrationId): ' +
    'deploymentUuid, status, breakerOpen, createdAt. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, projectSlug);
        await assertPrincipalIsMember(principal, projectId);
        const rows = await activeCoolifyIntegrations(projectId);
        return {
          integrations: rows.map((row) => ({
            id: row.id,
            environment: row.environment,
            resourceUuid: (row.config as CoolifyConfig | null)?.resourceUuid ?? null,
            lastHealthStatus: row.lastHealthStatus,
            breakerOpen: row.breakerOpenedAt !== null,
          })),
        };
      }

      case 'deploy': {
        if (!input.issueId) {
          throw new Error('BAD_REQUEST: issueId is required for deploy');
        }
        const projectId = await resolveProjectId(input, projectSlug);
        await assertPrincipalIsMember(principal, projectId);

        const runId = await resolveLatestIssueRunId(input.issueId);
        if (!runId) {
          return { dispatched: false, pendingHumanConfirm: false, integrationIds: [], reason: 'no-run' };
        }

        const outcome = await tryDispatchCoolifyRelease({
          projectId,
          issueId: input.issueId,
          runId,
        });
        return {
          dispatched: outcome.dispatched,
          pendingHumanConfirm: outcome.pendingHumanConfirm,
          integrationIds: outcome.integrationIds,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        };
      }

      case 'status': {
        const projectId = await resolveProjectId(input, projectSlug);
        await assertPrincipalIsMember(principal, projectId);
        const rows = await activeCoolifyIntegrations(projectId);
        const scoped = input.integrationId
          ? rows.filter((r) => r.id === input.integrationId)
          : rows;
        const deliveries = await Promise.all(
          scoped.map(async (row) => {
            const last = await findLastOutbound(row.id);
            const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
            return {
              integrationId: row.id,
              environment: row.environment,
              deploymentUuid: response?.deployment_uuid ?? null,
              status: last?.status ?? null,
              breakerOpen: row.breakerOpenedAt !== null,
              createdAt: last?.createdAt ?? null,
            };
          }),
        );
        return { deliveries };
      }
    }
  },
});
