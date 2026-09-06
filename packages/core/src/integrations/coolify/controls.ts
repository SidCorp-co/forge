/**
 * ISS-925 — the Coolify controls beside `deploy`: stopping one, undoing one,
 * and knowing which application a target actually is.
 *
 * Forge reached 4 of Coolify's operations, and the three gaps that cost an
 * operator most were all reachable: a build that is making the wrong thing ran
 * to completion, a rollback was a paragraph somebody read under pressure, and a
 * deploy target was a uuid transcribed out of another browser tab.
 *
 * These live beside `commands.ts` rather than inside it because that module is
 * the deploy path and has its own size budget; both are called by the REST
 * routes and the MCP tool, and neither checks authorisation — the surface does.
 */

import { randomUUID } from 'node:crypto';
import { DEPLOY_CONFIRM_WINDOW_MS } from '../../pipeline/deploy-confirmations.js';
import { prodActionNeedsHumanConfirm } from '../../pipeline/release-coolify.js';
import { findLastOutbound, recordDelivery, updateDelivery } from '../deliveries.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { buildContextFromBinding } from '../store.js';
import { CoolifyApiError, CoolifyClient } from './client.js';
import {
  activeCoolifyIntegrations,
  CoolifyCommandError,
  type CoolifyIntegrationRow,
  resolveIntegrationRow,
} from './commands.js';
import { enqueueCoolifyConfirm } from './confirm.js';
import { buildClient } from './log-fetch.js';
import type {
  CoolifyApplicationResponse,
  CoolifyConfig,
  CoolifyRollbackImage,
  CoolifySecrets,
  CoolifyTarget,
} from './types.js';

/** One application as the target picker shows it. */
export interface CoolifyApplicationSummary {
  uuid: string;
  name: string | null;
  fqdn: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  status: string | null;
}

/** A bound target with the identity Coolify reports for it. */
export interface CoolifyTargetIdentity extends CoolifyApplicationSummary {
  targetId: string;
  label: string;
  /** `false` when Coolify does not list this `resourceUuid` at all. */
  found: boolean;
}

export interface CoolifyRollbackImagesResult {
  integrationId: string;
  resourceUuid: string;
  targetLabel: string;
  current: string | null;
  images: { tag: string; createdAt: string | null; isCurrent: boolean }[];
}

export interface CoolifyControlOutcome {
  integrationId: string;
  /** `true` only when Coolify accepted the action and named what it started. */
  performed: boolean;
  pendingHumanConfirm: boolean;
  deploymentUuid: string | null;
  detail?: string;
}

function summarize(app: CoolifyApplicationResponse): CoolifyApplicationSummary {
  return {
    uuid: app.uuid,
    name: app.name ?? null,
    fqdn: app.fqdn ?? null,
    gitRepository: app.git_repository ?? null,
    gitBranch: app.git_branch ?? null,
    gitCommitSha: app.git_commit_sha ?? null,
    status: app.status ?? null,
  };
}

/**
 * The applications a Coolify credential can see. Takes the credential rather
 * than a binding so the settings picker works on the create form, before any
 * connection is persisted — the same two-mode shape `rocketchat/rooms` uses.
 */
export async function fetchCoolifyApplications(auth: {
  baseUrl: string;
  apiToken: string;
  previousApiToken?: string;
}): Promise<CoolifyApplicationSummary[]> {
  const client = new CoolifyClient(auth);
  return (await client.listApplications()).map(summarize);
}

/**
 * The same list, for an integration Forge already holds the credential for —
 * what the MCP tool and the bound-target panel use.
 */
export async function listApplicationsForIntegration(input: {
  projectId: string;
  integrationId?: string | undefined;
}): Promise<{ integrationId: string; applications: CoolifyApplicationSummary[] }> {
  const row = await requireIntegration(input);
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  return {
    integrationId: row.id,
    applications: (await buildClient(ctx).listApplications()).map(summarize),
  };
}

function requireRow(rows: CoolifyIntegrationRow[], input: { integrationId?: string | undefined }) {
  const row = resolveIntegrationRow(rows, input);
  if (!row) throw new CoolifyCommandError('project has no active Coolify integration');
  return row;
}

async function requireIntegration(input: {
  projectId: string;
  integrationId?: string | undefined;
}) {
  return requireRow(await activeCoolifyIntegrations(input.projectId), input);
}

function targetsOf(row: CoolifyIntegrationRow): CoolifyTarget[] {
  return (row.config as CoolifyConfig | null)?.targets ?? [];
}

/**
 * The one target the caller means: an explicit `resourceUuid`, else the sole
 * target. Several targets and no name is ambiguous — a rollback picked for the
 * caller is a rollback of the wrong application.
 */
function requireTarget(row: CoolifyIntegrationRow, resourceUuid?: string): CoolifyTarget {
  const targets = targetsOf(row);
  if (targets.length === 0) {
    throw new CoolifyCommandError('integration has no deploy targets configured');
  }
  if (!resourceUuid) {
    const sole = targets.length === 1 ? targets[0] : undefined;
    if (!sole) {
      throw new CoolifyCommandError(
        `integration has ${targets.length} targets — pass resourceUuid (${targets.map((t) => `${t.label}=${t.resourceUuid}`).join(', ')})`,
      );
    }
    return sole;
  }
  const match = targets.find((t) => t.resourceUuid === resourceUuid);
  if (!match) {
    throw new CoolifyCommandError(
      `resourceUuid ${resourceUuid} is not a deploy target of this integration`,
    );
  }
  return match;
}

/**
 * Every bound target of one integration, resolved against what Coolify lists.
 * One `listApplications()` call for the whole set, so a five-target binding
 * costs one round trip and a target Coolify does not know reads `found:false`
 * rather than throwing the whole panel away.
 */
export async function resolveCoolifyTargets(input: {
  projectId: string;
  integrationId?: string | undefined;
}): Promise<{ integrationId: string; targets: CoolifyTargetIdentity[] }> {
  const row = await requireIntegration(input);
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  const apps = await buildClient(ctx).listApplications();
  const byUuid = new Map(apps.map((a) => [a.uuid, a]));
  return {
    integrationId: row.id,
    targets: targetsOf(row).map((t) => {
      const app = byUuid.get(t.resourceUuid);
      const identity = app
        ? summarize(app)
        : {
            uuid: t.resourceUuid,
            name: null,
            fqdn: null,
            gitRepository: null,
            gitBranch: null,
            gitCommitSha: null,
            status: null,
          };
      return { targetId: t.id, label: t.label, found: Boolean(app), ...identity };
    }),
  };
}

export async function listCoolifyRollbackImages(input: {
  projectId: string;
  integrationId?: string | undefined;
  resourceUuid?: string | undefined;
}): Promise<CoolifyRollbackImagesResult> {
  const row = await requireIntegration(input);
  const target = requireTarget(row, input.resourceUuid);
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  const res = await buildClient(ctx).listRollbackImages(target.resourceUuid);
  return {
    integrationId: row.id,
    resourceUuid: target.resourceUuid,
    targetLabel: target.label,
    current: res.current ?? null,
    images: (res.images ?? [])
      .filter((i): i is CoolifyRollbackImage & { tag: string } => typeof i.tag === 'string')
      .map((i) => ({
        tag: i.tag,
        createdAt: i.created_at ?? null,
        isCurrent: i.is_current === true,
      })),
  };
}

/**
 * The issue's business rule, enforced here because Coolify does not enforce it:
 * a rollback target Coolify no longer lists is refused BY NAME.
 */
// cm:guard an empty `images` refuses too, and refusing it is the point: `rollback_images` catches its own failure and answers `{current:null, images:[]}` with a 200, so "Coolify listed nothing" and "Coolify could not reach the server" are the same bytes. Treating empty as "nothing to check against" would let every rollback through on exactly the reads that prove least.
export function assertRollbackTagListed(
  images: { tag: string }[],
  commit: string,
  targetLabel: string,
): void {
  if (images.length === 0) {
    throw new CoolifyCommandError(
      `Coolify listed no rollback images for ${targetLabel}, so "${commit}" cannot be confirmed to exist — refusing. An empty list also means the application's server was unreachable; check it before rolling back.`,
    );
  }
  if (images.some((i) => i.tag === commit)) return;
  throw new CoolifyCommandError(
    `rollback image "${commit}" is not listed by Coolify for ${targetLabel} — refusing. Coolify lists: ${images.map((i) => i.tag).join(', ')}`,
  );
}

/**
 * Roll one target back to an image Coolify still lists. Audited and polled the
 * way a deploy is: an outbound delivery, then a `coolify.confirm` job on the
 * `deployment_uuid` Coolify hands back.
 */
// cm:edge lockstep -> packages/core/src/integrations/coolify/confirm.ts — the rollback's own build is a deployment like any other, so it is confirmed by THAT poller and by nothing new; a second writer of a deployment's outcome is what `runs-cascade` forbids.
export async function runCoolifyRollback(input: {
  projectId: string;
  integrationId?: string | undefined;
  resourceUuid?: string | undefined;
  commit: string;
}): Promise<CoolifyControlOutcome> {
  const row = await requireIntegration(input);
  const target = requireTarget(row, input.resourceUuid);
  if (await prodActionNeedsHumanConfirm(input.projectId, row.environment)) {
    return pendingProd(row.id, 'rollback');
  }

  const listed = await listCoolifyRollbackImages({
    projectId: input.projectId,
    integrationId: row.id,
    resourceUuid: target.resourceUuid,
  });
  assertRollbackTagListed(listed.images, input.commit, target.label);

  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  return performControl({
    row,
    eventName: 'deploy.rollback.requested',
    payload: { targetId: target.id, targetLabel: target.label, commit: input.commit },
    targetLabel: `${target.label} rollback`,
    call: async () => {
      const res = await buildClient(ctx).rollbackApplication({
        resourceUuid: target.resourceUuid,
        commit: input.commit,
      });
      if (!res.deployment_uuid) {
        // cm:guard a 200 with no `deployment_uuid` is Coolify's `status:'skipped'` branch — the rollback was NOT queued, and reporting the 200 as success is a rollback an operator believes happened.
        throw new Error(
          `coolify rollback: accepted but queued nothing (${res.message ?? 'no message'}) — nothing was rolled back`,
        );
      }
      return { deploymentUuid: res.deployment_uuid, detail: res.message };
    },
  });
}

/**
 * Cancel a deployment this integration started. Nothing new confirms it:
 * Coolify reports `cancelled-by-user`, which `confirm.ts` already classifies as
 * a failure, so the in-flight poll settles the run on its next tick.
 */
export async function runCoolifyCancel(input: {
  projectId: string;
  integrationId?: string | undefined;
  deploymentUuid?: string | undefined;
}): Promise<CoolifyControlOutcome> {
  const row = await requireIntegration(input);
  if (await prodActionNeedsHumanConfirm(input.projectId, row.environment)) {
    return pendingProd(row.id, 'cancel');
  }

  let deploymentUuid = input.deploymentUuid ?? null;
  if (!deploymentUuid) {
    const last = await findLastOutbound(row.id);
    const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
    deploymentUuid = response?.deployment_uuid ?? null;
  }
  if (!deploymentUuid) {
    throw new CoolifyCommandError(
      'no deployment to cancel — this integration has recorded none, pass deploymentUuid',
    );
  }

  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  const uuid = deploymentUuid;
  return performControl({
    row,
    eventName: 'deploy.cancel.requested',
    payload: { deploymentUuid: uuid },
    call: async () => {
      const res = await buildClient(ctx).cancelDeployment(uuid);
      return { deploymentUuid: res.deployment_uuid ?? uuid, detail: res.status ?? res.message };
    },
  });
}

function pendingProd(integrationId: string, action: string): CoolifyControlOutcome {
  return {
    integrationId,
    performed: false,
    pendingHumanConfirm: true,
    deploymentUuid: null,
    detail: `${action} against a production binding is not dispatched without a human — confirm the production deploy gate, or set pipelineConfig.autoProdDeploy`,
  };
}

/**
 * One outbound delivery per control action, written before the call and closed
 * after it, so cancel and rollback appear in the audit log the same way a
 * deploy does rather than being the two actions nothing recorded.
 */
async function performControl(args: {
  row: CoolifyIntegrationRow;
  eventName: string;
  payload: Record<string, unknown>;
  /** When set, a `coolify.confirm` poll is queued for the resulting build. */
  targetLabel?: string;
  call: () => Promise<{ deploymentUuid: string; detail?: string | undefined }>;
}): Promise<CoolifyControlOutcome> {
  const { row } = args;
  const deliveryId = await recordDelivery({
    bindingId: row.id,
    direction: 'outbound',
    eventName: args.eventName,
    payload: { ...args.payload, runId: null, environment: row.environment },
    requestId: `control:${row.id}:${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: 'pending',
  });
  const started = Date.now();
  try {
    const { deploymentUuid, detail } = await args.call();
    await updateDelivery(deliveryId, {
      status: 'ok',
      response: { deployment_uuid: deploymentUuid, detail: detail ?? null },
      durationMs: Date.now() - started,
      completedAt: new Date(),
    });
    if (args.targetLabel) {
      await enqueueCoolifyConfirm(
        {
          jobKind: 'coolify.confirm',
          bindingId: row.id,
          runId: null,
          deliveryId,
          deploymentUuid,
          targetLabel: args.targetLabel,
          deadlineAt: new Date(Date.now() + DEPLOY_CONFIRM_WINDOW_MS).toISOString(),
        },
        { startAfterSeconds: 0 },
      );
    }
    return {
      integrationId: row.id,
      performed: true,
      pendingHumanConfirm: false,
      deploymentUuid,
      ...(detail ? { detail } : {}),
    };
  } catch (err) {
    const message =
      err instanceof CoolifyApiError
        ? `${err.message}${err.body ? `: ${err.body.slice(0, 400)}` : ''}`
        : err instanceof Error
          ? err.message
          : 'unknown error';
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: message,
      durationMs: Date.now() - started,
      completedAt: new Date(),
    });
    throw new CoolifyCommandError(message);
  }
}

/** Re-exported so a surface can build a picker client from stored secrets. */
export function credentialFromSecrets(
  config: CoolifyConfig,
  secrets: CoolifySecrets,
): { baseUrl: string; apiToken: string; previousApiToken?: string } {
  const auth: { baseUrl: string; apiToken: string; previousApiToken?: string } = {
    baseUrl: config.baseUrl,
    apiToken: secrets.apiToken,
  };
  if (secrets.previousApiToken && isPreviousCredentialValid(secrets)) {
    auth.previousApiToken = secrets.previousApiToken;
  }
  return auth;
}
