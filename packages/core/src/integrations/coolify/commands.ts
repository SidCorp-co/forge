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
import { DeployEnvironmentLockedError } from '../../pipeline/deploy-lock.js';
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
import { WHO_CHANGES } from '../binding-acts.js';
import { findLastOutbound, findLastOutboundForTarget } from '../deliveries.js';
import { isRemovedConnection, type OffPair, offBindingWords } from '../held-key.js';
import { getIntegration } from '../registry.js';
import {
  effectiveConfig,
  listActiveDeployBindingsForProvider,
  listBindingsForProject,
} from '../store.js';
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
  const refused = notGrantedMessage('coolify', ungranted.pair.connection);
  if (integrationId) throw new CoolifyCommandError(refused);
  throw new CoolifyCommandError(
    `${refused} This call named no integrationId, so it would have read every Coolify deploy target on the project, that one included. Name the deploy target you mean with integrationId and a granted one still answers.`,
  );
}

/** A Coolify call over a binding whose connection was removed: answered as the application list is. */
export class CoolifyConnectionRemovedError extends CoolifyCommandError {
  constructor(message: string) {
    super(message);
    this.name = 'CoolifyConnectionRemovedError';
  }
}

const NOTHING_ASKED = 'Nothing was asked of Coolify.';

/**
 * Pick the one integration the caller means: an explicit `integrationId`, else the project's sole
 * active integration. Null where the project has no Coolify binding at all, the one case a caller
 * shapes itself. Anything else that answers nothing is refused saying why and who may put it back,
 * read off the bindings and their connections (ISS-1421 r29, judge-119 on 316): it said "no active
 * Coolify integration with that integrationId" over a removed connection the project still binds.
 */
export async function resolveIntegrationRow<T extends { id: string }>(
  projectId: string,
  rows: T[],
  input: { integrationId?: string | undefined },
): Promise<T | null> {
  const row = input.integrationId
    ? rows.find((r) => r.id === input.integrationId)
    : rows.length === 1
      ? rows[0]
      : undefined;
  if (row) return row;
  if (rows.length > 1 && !input.integrationId) {
    throw new CoolifyCommandError(
      `This project has ${rows.length} Coolify deploy targets switched on, so Forge cannot tell which one is meant. Name the one meant by its id, which the list of this project's Coolify deploy targets gives. ${NOTHING_ASKED}`,
    );
  }
  const bound = (await listBindingsForProject(projectId)).filter(
    (p) => p.binding.provider === 'coolify' && p.binding.role === 'deploy',
  );
  const dead = input.integrationId
    ? bound.find((p) => p.binding.id === input.integrationId)
    : bound.find((p) => !(p.binding.active && p.connection.active));
  if (dead) throw await offBindingRefusal(dead, projectId);
  if (input.integrationId) {
    throw new CoolifyCommandError(
      `None of this project's Coolify deploy targets has the id that was named; the list of this project's Coolify deploy targets gives the ids it has. ${NOTHING_ASKED}`,
    );
  }
  return null;
}

/** A dead binding's refusal at every Coolify door, the application list included (ISS-1421 r30). */
export async function offBindingRefusal(
  dead: OffPair,
  projectId: string,
): Promise<CoolifyCommandError> {
  const said = `This project's Coolify deploy target answers nothing: ${await offBindingWords(dead, projectId)} ${NOTHING_ASKED}`;
  return isRemovedConnection(dead.connection)
    ? new CoolifyConnectionRemovedError(said)
    : new CoolifyCommandError(said);
}

/** The project's Coolify said absent: who may connect one, and where (ISS-1421 r29). */
export const NO_COOLIFY = `This project has no Coolify connected. Only ${WHO_CHANGES} can connect it, on the project's Integrations tab. ${NOTHING_ASKED}`;

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
 * The only thing establishing, before production changes, that this session's credential reaches
 * the half that records what the deploy did (ISS-1211).
 *
 * It read as a method gate and never was one: `readRunMethod` answers non-null for any
 * announcement, `loaded: false` included. ISS-1276 removed the method gate at `finish` and renamed
 * this to say what it checks — a run announcing that its method would not load still deploys.
 */
export const RELEASE_DEPLOY_BEFORE_RECORDING =
  'RELEASE_NOTHING_RECORDED: this release run has recorded nothing through forge_release_batch, so nothing ' +
  'shows the credential it runs on can record what this deploy would do. Make one call first — action=method ' +
  'says what you are working from, and `loaded: false` with a detail is a valid answer — then deploy. ' +
  'A release deploy is refused before production changes, never after.';

export async function runCoolifyDeploy(input: {
  projectId: string;
  issueId?: string | undefined;
  pipelineRunId?: string | undefined;
  integrationId?: string | undefined;
}) {
  const { projectId } = input;
  const rows = await activeCoolifyIntegrations(projectId);
  // Nothing to deploy to is refused by name on every path, and a named binding that answers
  // nothing says why: a write that does nothing is never a 200 (ISS-1421 r30).
  if (rows.length === 0 || input.integrationId) {
    if (!(await resolveIntegrationRow(projectId, rows, input))) {
      throw new CoolifyCommandError(NO_COOLIFY);
    }
  }

  if (input.pipelineRunId && !input.issueId) {
    if (!(await isOpenReleaseBatchRun(projectId, input.pipelineRunId))) {
      throw new CoolifyCommandError(
        'pipelineRunId is not an open release-batch run for this project',
      );
    }
    if ((await readRunMethod(input.pipelineRunId)) === null) {
      throw new CoolifyCommandError(RELEASE_DEPLOY_BEFORE_RECORDING);
    }
    // ISS-1279 — the release path, and the only caller that takes the deploy lock: a release
    // reaching an environment another is mid-deploy to is refused rather than queued.
    try {
      return shape(
        await tryDispatchCoolifyRelease({
          projectId,
          issueId: null,
          runId: input.pipelineRunId,
          integrationId: input.integrationId ?? null,
          allowLive: true,
          takeEnvironmentLock: true,
        }),
      );
    } catch (err) {
      if (err instanceof DeployEnvironmentLockedError) {
        throw new CoolifyCommandError(err.message);
      }
      throw err;
    }
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

  const row = await resolveIntegrationRow(projectId, rows, input);
  if (!row) throw new CoolifyCommandError(NO_COOLIFY);
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
