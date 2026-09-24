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

import type { DeployStage } from '../../db/schema.js';
import { effectiveConfig, listActiveDeployBindingsForProvider } from '../../integrations/store.js';
import {
  type DispatchOutcome,
  dispatchCoolifyDeployDirect,
  isIssueAtReleaseStage,
  resolveLatestIssueRunId,
  tryDispatchCoolifyRelease,
} from '../../pipeline/release-coolify.js';
import { readRunMethod } from '../../release-batch/method.js';
import { isOpenReleaseBatchRun } from '../../release-batch/service.js';
import { grantHolds, notGrantedMessage } from '../agent-access.js';
import { findLastOutbound, findLastOutboundForTarget } from '../deliveries.js';
import { getIntegration } from '../registry.js';
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
  const pairs = await listActiveDeployBindingsForProvider(projectId, 'coolify');
  return pairs.map((pair) => ({
    id: pair.binding.id,
    stages: (pair.binding.stages ?? []) as DeployStage[],
    config: effectiveConfig<CoolifyConfig>(pair),
    lastHealthStatus: pair.connection.lastHealthStatus,
    breakerOpenedAt: pair.connection.breakerOpenedAt,
    pair,
  }));
}

export type CoolifyIntegrationRow = Awaited<ReturnType<typeof activeCoolifyIntegrations>>[number];

export function assertAgentMayDeployCoolify(
  rows: CoolifyIntegrationRow[],
  integrationId: string | undefined,
): void {
  if (rows.length === 0) return;
  const candidates = integrationId ? rows.filter((r) => r.id === integrationId) : rows;
  if (candidates.length === 0) return;
  const decl = getIntegration('coolify');
  // EVERY candidate, not `some`. Without an id, `status`, `logs`, `cancel` and `rollback` read the
  // project's whole Coolify set, so one granted binding letting the action through would hand the
  // agent an ungranted binding's deliveries — a per-binding switch that only holds per project.
  const ungranted = candidates.find((r) => !grantHolds(decl, r.pair.binding));
  if (!ungranted) return;
  if (integrationId) throw new CoolifyCommandError(notGrantedMessage('coolify', ungranted.id));
  throw new CoolifyCommandError(
    `${notGrantedMessage('coolify', ungranted.id)} This call named no integrationId, so it would have read every Coolify binding on the project, that one included. Name the binding you mean with integrationId and a granted one still answers.`,
  );
}

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
      stages: row.stages,
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

/**
 * `finish` refuses a release run that announced no method. Refusing the same run
 * here puts that refusal ahead of the deploy Forge performs rather than after
 * it: the announcement is the first write a run makes to its batch, so a run
 * that made it has shown its credential reaches the recording half (ISS-1211).
 */
export const RELEASE_DEPLOY_BEFORE_METHOD =
  'RELEASE_METHOD_NOT_ANNOUNCED: this release run has announced no method, so nothing shows the credential ' +
  'it runs on can record what this deploy would do. Announce it first with forge_release_batch action=method ' +
  '(the tool and credential finish takes), then deploy. A release deploy is refused before production changes, never after.';

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
    if ((await readRunMethod(input.pipelineRunId)) === null) {
      throw new CoolifyCommandError(RELEASE_DEPLOY_BEFORE_METHOD);
    }
    return shape(
      await tryDispatchCoolifyRelease({
        projectId,
        issueId: null,
        runId: input.pipelineRunId,
        integrationId: input.integrationId ?? null,
        allowLive: true,
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
        allowLive: await isIssueAtReleaseStage(input.issueId),
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
        const base = { integrationId: row.id, stages: row.stages };
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
