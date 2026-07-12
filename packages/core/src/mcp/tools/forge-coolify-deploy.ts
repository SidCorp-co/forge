/**
 * ISS-242 — Action-dispatcher MCP tool `forge_coolify_deploy` that the stock
 * pipeline skills (forge-release / forge-staging / forge-code / forge-fix /
 * forge-test) already call but which had no server-side implementation,
 * causing a tool-not-found at the deploy step.
 *
 * Actions:
 *  - `list`   — active Coolify integrations for the project; drives the
 *               skills' "local-only mode" detection (empty array → no Coolify).
 *  - `deploy` — enqueue a Coolify deploy. `issueId` is optional (ISS-312):
 *               with it, a run-tracked deploy via the EXACT dispatch path the
 *               release auto-subscriber uses (`tryDispatchCoolifyRelease` →
 *               `enqueueCoolifyDispatch`); without it, a run-less resource
 *               redeploy (`dispatchCoolifyDeployDirect`, `runId=null`) that
 *               resolves the integration like the `logs` action and advances no
 *               pipeline. Each call is its own per-attempt requestId.
 *  - `status` — latest outbound delivery (deployment_uuid / ok|failed|pending /
 *               breaker) per integration, or for a specific `integrationId`.
 *
 * Authorization is membership-level (`assertPrincipalIsMember`) like
 * `forge_issues`; prod safety is the human-confirm gate inside
 * `tryDispatchCoolifyRelease`, not RBAC. No DEVICE_REQUIRED entry — the tool
 * has no runner dependency.
 */

import { z } from 'zod';
import { fetchCoolifyDeploymentLogs } from '../../integrations/coolify/adapter.js';
import { CoolifyApiError } from '../../integrations/coolify/client.js';
import type { CoolifyConfig } from '../../integrations/coolify/types.js';
import { findLastOutbound, findLastOutboundForTarget } from '../../integrations/deliveries.js';
import { effectiveConfig, listActiveBindingsForProjectProvider } from '../../integrations/store.js';
import {
  dispatchCoolifyDeployDirect,
  isIssueAtReleaseStage,
  resolveLatestIssueRunId,
  tryDispatchCoolifyRelease,
} from '../../pipeline/release-coolify.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  resolveEffectiveProjectId,
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

async function resolveProjectId(input: Input, ctx: McpContext): Promise<string> {
  return resolveEffectiveProjectId(ctx, input.projectId);
}

/**
 * Active Coolify bindings for a project, flattened to the shape the tool's
 * actions consume. `id` is the BINDING id (== old project_integration id for
 * backfilled rows, so the runner-facing `integrationId` values are stable).
 * Health/breaker come from the owning connection; config is the effective
 * connection⊕binding overlay. `pair` is retained for the `logs` action.
 */
async function activeCoolifyIntegrations(projectId: string) {
  const pairs = await listActiveBindingsForProjectProvider(projectId, 'coolify');
  return pairs.map((pair) => ({
    id: pair.binding.id,
    environment: pair.binding.environment,
    config: effectiveConfig<CoolifyConfig>(pair),
    lastHealthStatus: pair.connection.lastHealthStatus,
    breakerOpenedAt: pair.connection.breakerOpenedAt,
    pair,
  }));
}

export const forgeCoolifyDeployTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_coolify_deploy',
  description:
    'Coolify deploy controls for the pipeline skills. Actions: list | deploy | status | logs. ' +
    'MODEL: one integration = one project+ENVIRONMENT binding (staging vs prod are SEPARATE ' +
    'integrations). Each integration deploys ONE OR MORE targets[] — each target is its own Coolify ' +
    'application (e.g. a split backend + frontend, or a worker), deployed TOGETHER. A single deploy ' +
    'FANS OUT to every target of the integration (one Coolify build per target); the pipeline run is ' +
    'marked done only when EVERY target webhook reports success, and FAILS on the first target ' +
    'failure. So if an app (e.g. the backend) is not deploying, check it is CONFIGURED as a target on ' +
    'that integration (project settings → Integrations) — Forge only deploys the targets the ' +
    'integration holds. ' +
    'list: active Coolify integrations for the project (id, environment, targets[]={id,label,' +
    'resourceUuid}, lastHealthStatus, breakerOpen); empty array => project is local-only (no Coolify). ' +
    'Inspect targets[] to confirm every app you expect (BE+FE) is present. ' +
    'deploy: issueId is OPTIONAL; dispatches ALL targets of the resolved integration. With issueId — ' +
    "run-tracked deploy: resolves the issue's latest pipeline run and enqueues via the SAME path as " +
    'the release auto-subscriber (each target webhook then advances that run; run completes when all ' +
    'targets succeed). When issueId is combined with integrationId, integrationId is a HARD scope ' +
    'filter — ONLY that binding dispatches, even if other bindings (e.g. prod) exist on the run. ' +
    'When issueId is given WITHOUT integrationId, prod-environment bindings are dispatched ONLY when ' +
    'the issue has reached the release stage (status released/closed) — every pre-release call ' +
    '(code/fix/testing) is staging-only and NEVER touches a prod binding, regardless of ' +
    'pipelineConfig.autoProdDeploy (that flag only bypasses the gate for the release-triggered ' +
    'auto-subscriber, not for this tool pre-release). Without issueId — run-less resource redeploy: ' +
    'resolves the target integration like the logs action (explicit integrationId, else the single ' +
    'active Coolify integration, else BAD_REQUEST when multiple exist) and dispatches with no run ' +
    'attached (webhooks record deliveries but advance no pipeline). Each call is its own dispatch ' +
    '(per-attempt requestId, suffixed per target) and Coolify force-rebuilds, so re-deploying after a ' +
    'branch fix fires fresh builds. At the release stage, prod integrations still honor the ' +
    'human-confirm gate (unless the project sets pipelineConfig.autoProdDeploy): returns ' +
    'pendingHumanConfirm:true and does NOT dispatch until confirmed via the confirm-prod-deploy ' +
    'endpoint. ' +
    'status: latest outbound delivery PER TARGET for the integration(s) (or a specific integrationId): ' +
    'deploymentUuid, status, breakerOpen, createdAt — expect one row per target. ' +
    'logs: fetch the Coolify build/deploy log for a deployment and return it scrubbed + tailed. ' +
    'Resolves deploymentUuid from the explicit deploymentUuid param, else the most recent outbound ' +
    'delivery (across the integration targets) — pass deploymentUuid to target a specific app/target. ' +
    'Requires integrationId when multiple active Coolify integrations exist. ' +
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
    const { principal } = ctx;

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);
        const rows = await activeCoolifyIntegrations(projectId);
        return {
          integrations: rows.map((row) => ({
            id: row.id,
            environment: row.environment,
            targets: ((row.config as CoolifyConfig | null)?.targets ?? []).map((t) => ({
              id: t.id,
              label: t.label,
              resourceUuid: t.resourceUuid,
            })),
            lastHealthStatus: row.lastHealthStatus,
            breakerOpen: row.breakerOpenedAt !== null,
          })),
        };
      }

      case 'deploy': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsWriter(principal, projectId);

        // issueId present → run-tracked deploy (unchanged): resolve the issue's
        // latest run and dispatch via the shared release path.
        if (input.issueId) {
          const runId = await resolveLatestIssueRunId(input.issueId);
          if (!runId) {
            return {
              dispatched: false,
              pendingHumanConfirm: false,
              integrationIds: [],
              reason: 'no-run',
            };
          }

          const allowProd = await isIssueAtReleaseStage(input.issueId);
          const outcome = await tryDispatchCoolifyRelease({
            projectId,
            issueId: input.issueId,
            runId,
            integrationId: input.integrationId ?? null,
            allowProd,
          });
          return {
            dispatched: outcome.dispatched,
            pendingHumanConfirm: outcome.pendingHumanConfirm,
            integrationIds: outcome.integrationIds,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          };
        }

        // No issueId → run-less resource redeploy (ISS-312). Resolve the target
        // integration the same way the `logs` action does: explicit
        // integrationId wins; else the single active Coolify integration; else
        // ambiguous BAD_REQUEST.
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
              dispatched: false,
              pendingHumanConfirm: false,
              integrationIds: [],
              reason: 'no-integration',
            };
          }
          throw new Error('BAD_REQUEST: multiple active Coolify integrations — pass integrationId');
        }

        const outcome = await dispatchCoolifyDeployDirect({ projectId, integrationId: row.id });
        return {
          dispatched: outcome.dispatched,
          pendingHumanConfirm: outcome.pendingHumanConfirm,
          integrationIds: outcome.integrationIds,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        };
      }

      case 'status': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);
        const rows = await activeCoolifyIntegrations(projectId);
        const scoped = input.integrationId
          ? rows.filter((r) => r.id === input.integrationId)
          : rows;
        // One row PER TARGET (backend / frontend / …) so an operator can see
        // each app of a multi-target integration independently. Legacy/empty
        // targets fall back to a single integration-level row.
        const deliveries = (
          await Promise.all(
            scoped.map(async (row) => {
              const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
              if (targets.length === 0) {
                const last = await findLastOutbound(row.id);
                const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
                return [
                  {
                    integrationId: row.id,
                    environment: row.environment,
                    targetId: null,
                    targetLabel: null,
                    deploymentUuid: response?.deployment_uuid ?? null,
                    status: last?.status ?? null,
                    breakerOpen: row.breakerOpenedAt !== null,
                    createdAt: last?.createdAt ?? null,
                  },
                ];
              }
              return Promise.all(
                targets.map(async (t) => {
                  const last = await findLastOutboundForTarget(row.id, t.id);
                  const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
                  return {
                    integrationId: row.id,
                    environment: row.environment,
                    targetId: t.id,
                    targetLabel: t.label,
                    deploymentUuid: response?.deployment_uuid ?? null,
                    status: last?.status ?? null,
                    breakerOpen: row.breakerOpenedAt !== null,
                    createdAt: last?.createdAt ?? null,
                  };
                }),
              );
            }),
          )
        ).flat();
        return { deliveries };
      }

      case 'logs': {
        const projectId = await resolveProjectId(input, ctx);
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
          const result = await fetchCoolifyDeploymentLogs(row.pair, deploymentUuid);
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
