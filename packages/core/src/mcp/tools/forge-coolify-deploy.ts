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
import { fetchCoolifyDeploymentLogs } from '../../integrations/coolify/adapter.js';
import { CoolifyApiError } from '../../integrations/coolify/client.js';
import type { CoolifyConfig } from '../../integrations/coolify/types.js';
import { findLastOutbound } from '../../integrations/deliveries.js';
import {
  resolveLatestIssueRunId,
  tryDispatchCoolifyRelease,
} from '../../pipeline/release-coolify.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['list', 'deploy', 'status', 'logs']),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
    deploymentUuid: z.string().optional(),
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

export const forgeCoolifyDeployTool: ContextScopedMcpToolFactory = ({
  principal,
  projectSlug,
}) => ({
  name: 'forge_coolify_deploy',
  description:
    'Coolify deploy controls for the pipeline skills. Actions: list | deploy | status | logs. ' +
    'list: active Coolify integrations for the project (id, environment, resourceUuid, ' +
    'lastHealthStatus, breakerOpen); empty array => project is local-only (no Coolify). ' +
    "deploy: requires issueId — resolves the issue's latest pipeline run and enqueues a " +
    'deploy via the SAME path as the release auto-subscriber. Each call is its own dispatch ' +
    '(per-attempt requestId) and Coolify force-rebuilds, so re-deploying the same run after a ' +
    'branch fix actually fires a fresh build. ' +
    'prod integrations honor the human-confirm gate: returns pendingHumanConfirm:true and does ' +
    'NOT dispatch until confirmed via the confirm-prod-deploy endpoint. ' +
    'status: latest outbound delivery per integration (or a specific integrationId): ' +
    'deploymentUuid, status, breakerOpen, createdAt. ' +
    'logs: fetch the Coolify build/deploy log for a deployment and return it scrubbed + tailed. ' +
    "Resolves deploymentUuid from the explicit deploymentUuid param, else the integration's last " +
    'outbound delivery. Requires integrationId when multiple active Coolify integrations exist. ' +
    'Secrets (Authorization/Cookie/X-Api-Key headers, token/apiKey/password/jwt fields, tokenized ' +
    "URLs, and the integration's own apiToken) are redacted line-by-line; build-stage stderr is " +
    'preserved. Returns { integrationId, deploymentUuid, status, logs, truncated }; on a Coolify API ' +
    'error returns { error, httpStatus } with no raw body. Tailed to last ~100 lines / ~16KB ' +
    '(truncated:true when cut). ' +
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
          return {
            dispatched: false,
            pendingHumanConfirm: false,
            integrationIds: [],
            reason: 'no-run',
          };
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

      case 'logs': {
        const projectId = await resolveProjectId(input, projectSlug);
        await assertPrincipalIsMember(principal, projectId);

        // Resolve the integration row. Explicit integrationId wins; otherwise
        // require exactly one active Coolify integration (multiple is ambiguous).
        const rows = await activeCoolifyIntegrations(projectId);
        const row = input.integrationId
          ? rows.find((r) => r.id === input.integrationId)
          : rows.length === 1
            ? rows[0]
            : undefined;
        if (!row) {
          if (input.integrationId) {
            throw new Error('BAD_REQUEST: no active Coolify integration with that integrationId');
          }
          if (rows.length === 0) {
            return {
              integrationId: null,
              deploymentUuid: null,
              logs: null,
              reason: 'no-integration',
            };
          }
          throw new Error('BAD_REQUEST: multiple active Coolify integrations — pass integrationId');
        }

        // Resolve the deploymentUuid: explicit param, else the integration's
        // last outbound delivery (its Coolify response carries deployment_uuid).
        let deploymentUuid = input.deploymentUuid ?? null;
        if (!deploymentUuid) {
          const last = await findLastOutbound(row.id);
          const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
          deploymentUuid = response?.deployment_uuid ?? null;
        }
        if (!deploymentUuid) {
          return {
            integrationId: row.id,
            deploymentUuid: null,
            logs: null,
            reason: 'no-deployment',
          };
        }

        try {
          const result = await fetchCoolifyDeploymentLogs(row, deploymentUuid);
          return { integrationId: row.id, ...result };
        } catch (err) {
          // Surface a clear message; NEVER echo the raw Coolify body (may leak).
          if (err instanceof CoolifyApiError) {
            return {
              integrationId: row.id,
              deploymentUuid,
              logs: null,
              error: 'coolify API error',
              httpStatus: err.status,
            };
          }
          throw err;
        }
      }
    }
  },
});
