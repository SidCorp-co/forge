/**
 * The Coolify deploy commands, for every surface that offers them.
 *
 * These lived inside `mcp/tools/forge-coolify-deploy.ts`, which made the MCP
 * tool the only way to reach them. The REST twin under
 * `/api/projects/:projectId/integrations/...` calls the same functions rather
 * than restating the branch rules — `deploy` in particular decides whether a
 * PROD binding may dispatch, and that decision must not exist twice.
 *
 * Authorisation is the CALLER's job: each surface knows its own principal.
 * Nothing here checks membership.
 */

import { effectiveConfig, listActiveBindingsForProjectProvider } from '../../integrations/store.js';
import {
  type DispatchOutcome,
  dispatchCoolifyDeployDirect,
  isIssueAtReleaseStage,
  resolveLatestIssueRunId,
  tryDispatchCoolifyRelease,
} from '../../pipeline/release-coolify.js';
import { isOpenReleaseBatchRun } from '../../release-batch/service.js';
import { findLastOutbound, findLastOutboundForTarget } from '../deliveries.js';
import type { CoolifyConfig } from './types.js';

export class CoolifyCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoolifyCommandError';
  }
}

/**
 * Active Coolify bindings for a project, flattened to the shape the commands
 * consume. `id` is the BINDING id (== old project_integration id for
 * backfilled rows, so the runner-facing `integrationId` values are stable).
 * Health/breaker come from the owning connection; config is the effective
 * connection⊕binding overlay. `pair` is retained for the log commands.
 */
export async function activeCoolifyIntegrations(projectId: string) {
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

export type CoolifyIntegrationRow = Awaited<ReturnType<typeof activeCoolifyIntegrations>>[number];

/**
 * Pick the one integration the caller means: an explicit `integrationId`, else
 * the project's sole active integration. Returns null when the project has
 * none — the only case the caller must shape itself, because each command's
 * "nothing configured" payload names different fields.
 */
export function resolveIntegrationRow<T extends { id: string }>(
  rows: T[],
  input: { integrationId?: string | undefined },
): T | null {
  const row = input.integrationId
    ? rows.find((r) => r.id === input.integrationId)
    : rows.length === 1
      ? rows[0]
      : undefined;
  if (row) return row;
  if (input.integrationId) {
    throw new CoolifyCommandError('no active Coolify integration with that integrationId');
  }
  if (rows.length === 0) return null;
  throw new CoolifyCommandError('multiple active Coolify integrations — pass integrationId');
}

export async function listCoolifyIntegrations(projectId: string) {
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

const shape = (outcome: DispatchOutcome) => ({
  dispatched: outcome.dispatched,
  pendingHumanConfirm: outcome.pendingHumanConfirm,
  integrationIds: outcome.integrationIds,
  ...(outcome.reason ? { reason: outcome.reason } : {}),
});

// cm:guard the three branches decide whether PROD may dispatch, and each earns its `allowProd` differently: a bare `pipelineRunId` is trusted ONLY after `isOpenReleaseBatchRun` proves it is this project's own open release-batch run, an `issueId` earns it only by having reached the release stage, and the run-less branch never asks for it at all (`dispatchCoolifyDeployDirect` refuses prod on its own unless the project opted into autoProdDeploy). Never widen the first branch to an arbitrary run id — that is a prod deploy dispatched on a caller-supplied uuid.
export async function runCoolifyDeploy(input: {
  projectId: string;
  issueId?: string | undefined;
  pipelineRunId?: string | undefined;
  integrationId?: string | undefined;
}) {
  const { projectId } = input;

  if (input.pipelineRunId && !input.issueId) {
    if (!(await isOpenReleaseBatchRun(projectId, input.pipelineRunId))) {
      throw new CoolifyCommandError(
        'pipelineRunId is not an open release-batch run for this project',
      );
    }
    return shape(
      await tryDispatchCoolifyRelease({
        projectId,
        issueId: null,
        runId: input.pipelineRunId,
        integrationId: input.integrationId ?? null,
        allowProd: true,
      }),
    );
  }

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
    return shape(
      await tryDispatchCoolifyRelease({
        projectId,
        issueId: input.issueId,
        runId,
        integrationId: input.integrationId ?? null,
        allowProd: await isIssueAtReleaseStage(input.issueId),
      }),
    );
  }

  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row) {
    return {
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [],
      reason: 'no-integration',
    };
  }
  return shape(await dispatchCoolifyDeployDirect({ projectId, integrationId: row.id }));
}

/**
 * One row PER TARGET (backend / frontend / …) so an operator can see each app
 * of a multi-target integration independently. Legacy/empty targets fall back
 * to a single integration-level row.
 */
export async function coolifyDeliveryStatus(input: {
  projectId: string;
  integrationId?: string | undefined;
}) {
  const rows = await activeCoolifyIntegrations(input.projectId);
  const scoped = input.integrationId ? rows.filter((r) => r.id === input.integrationId) : rows;
  const deliveries = (
    await Promise.all(
      scoped.map(async (row) => {
        const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
        const base = { integrationId: row.id, environment: row.environment };
        const breakerOpen = row.breakerOpenedAt !== null;
        if (targets.length === 0) {
          const last = await findLastOutbound(row.id);
          const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
          return [
            {
              ...base,
              targetId: null,
              targetLabel: null,
              deploymentUuid: response?.deployment_uuid ?? null,
              status: last?.status ?? null,
              breakerOpen,
              createdAt: last?.createdAt ?? null,
            },
          ];
        }
        return Promise.all(
          targets.map(async (t) => {
            const last = await findLastOutboundForTarget(row.id, t.id);
            const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
            return {
              ...base,
              targetId: t.id,
              targetLabel: t.label,
              deploymentUuid: response?.deployment_uuid ?? null,
              status: last?.status ?? null,
              breakerOpen,
              createdAt: last?.createdAt ?? null,
            };
          }),
        );
      }),
    )
  ).flat();
  return { deliveries };
}
