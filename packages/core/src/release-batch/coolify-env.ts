/**
 * ISS-827 — the env door on a Coolify binding: the variable names of an application the project's
 * binding names, and setting or deleting one of them. The binding is the scope, never the token:
 * the token reaches every resource on its Coolify server, and the application acted on is one of
 * the binding's own targets or the act is refused by name (`requireTarget`).
 *
 * A value goes one way, from the caller to Coolify. The client drops values where it parses
 * Coolify's list and drops Coolify's answer body from a failed env call
 * (`integrations/deploy/coolify/client.ts`), every listed value is answered as the mask, and the
 * audit row each write leaves names the key and nothing of the value.
 *
 * Authorisation is the caller's: the REST routes declare `deploys.run` on the project.
 */

import { randomUUID } from 'node:crypto';
import {
  buildClient,
  CoolifyApiError,
  type CoolifyConfig,
  type CoolifySecrets,
  type CoolifyTarget,
} from '../integrations/deploy/index.js';
import { buildContextFromBinding, recordDelivery, updateDelivery } from '../integrations/index.js';
import { type CoolifyIntegrationRow, refuseCoolify, runCoolifyDeploy } from './coolify-commands.js';
import { requireIntegration, requireTarget } from './coolify-controls.js';

/** What every listed value is answered as: the same for every value, so it says nothing of one. */
export const COOLIFY_ENV_MASK = '********';

interface EnvScope {
  projectId: string;
  integrationId?: string | undefined;
  resourceUuid?: string | undefined;
}

interface EnvWriteInput extends EnvScope {
  key: string;
  /** The user acting, recorded on the audit row. */
  actorId: string | null;
  /** Redeploy the application after the write, through the deploy act (`runCoolifyDeploy`). */
  redeploy?: boolean | undefined;
}

async function scoped(input: EnvScope) {
  const row = await requireIntegration(input);
  const target = requireTarget(row, input.resourceUuid);
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(row.pair);
  return { row, target, client: buildClient(ctx) };
}

const where = (row: CoolifyIntegrationRow, target: CoolifyTarget) => ({
  integrationId: row.id,
  resourceUuid: target.resourceUuid,
  targetLabel: target.label,
});

/** The production variables' names of one bound application, every value masked. */
export async function listCoolifyEnv(input: EnvScope) {
  const { row, target, client } = await scoped(input);
  const keys = await client.listApplicationEnvKeys(target.resourceUuid);
  return {
    ...where(row, target),
    env: keys.map((k) => ({ key: k.key, value: COOLIFY_ENV_MASK, isPreview: k.isPreview })),
  };
}

/** Create the variable, or update it where the application already holds that key. */
export async function setCoolifyEnv(input: EnvWriteInput & { value: string }) {
  const { row, target, client } = await scoped(input);
  const held = await heldKey(client, target, input.key);
  const env = { key: input.key, value: input.value };
  await audited(row, target, input, held ? 'deploy.env.updated' : 'deploy.env.created', () =>
    held
      ? client.updateApplicationEnv(target.resourceUuid, env)
      : client.createApplicationEnv(target.resourceUuid, env),
  );
  return {
    ...where(row, target),
    key: input.key,
    action: held ? ('updated' as const) : ('created' as const),
    redeploy: await redeployAfter(input, row, target),
  };
}

/** Delete a variable the application holds; a key it does not hold is refused by name. */
export async function deleteCoolifyEnv(input: EnvWriteInput) {
  const { row, target, client } = await scoped(input);
  const held = await heldKey(client, target, input.key);
  if (!held) {
    throw refuseCoolify(
      'COOLIFY_ENV_KEY_UNKNOWN',
      `application ${target.label} (${target.resourceUuid}) holds no production variable named ${input.key}; GET /api/projects/${input.projectId}/integrations/coolify/env lists the ones it holds`,
    );
  }
  await audited(row, target, input, 'deploy.env.deleted', () =>
    client.deleteApplicationEnv(target.resourceUuid, held.uuid),
  );
  return {
    ...where(row, target),
    key: input.key,
    action: 'deleted' as const,
    redeploy: await redeployAfter(input, row, target),
  };
}

async function heldKey(client: ReturnType<typeof buildClient>, target: CoolifyTarget, key: string) {
  const keys = await client.listApplicationEnvKeys(target.resourceUuid);
  return keys.find((k) => k.key === key && !k.isPreview) ?? null;
}

/**
 * One outbound delivery per env write, written before the call and closed after it, as a deploy,
 * cancel and rollback are. It names the key, the application and the actor; no value, and on a
 * failure Coolify's status and route, never its answer body.
 */
async function audited(
  row: CoolifyIntegrationRow,
  target: CoolifyTarget,
  input: EnvWriteInput,
  eventName: string,
  call: () => Promise<void>,
): Promise<void> {
  const deliveryId = await recordDelivery({
    bindingId: row.id,
    direction: 'outbound',
    eventName,
    payload: {
      keys: [input.key],
      targetId: target.id,
      targetLabel: target.label,
      resourceUuid: target.resourceUuid,
      actorId: input.actorId,
      runId: null,
      environment: row.environment,
    },
    requestId: `env:${row.id}:${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: 'pending',
  });
  const started = Date.now();
  try {
    await call();
  } catch (err) {
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage:
        err instanceof CoolifyApiError
          ? `Coolify answered HTTP ${err.status} to ${err.route ?? 'the env call'}`
          : 'the env call to Coolify failed before an answer',
      durationMs: Date.now() - started,
      completedAt: new Date(),
    });
    throw err;
  }
  await updateDelivery(deliveryId, {
    status: 'ok',
    response: { keys: [input.key] },
    durationMs: Date.now() - started,
    completedAt: new Date(),
  });
}

/** The deploy act, for the one application written to; `null` when no redeploy was asked. */
async function redeployAfter(
  input: EnvWriteInput,
  row: CoolifyIntegrationRow,
  target: CoolifyTarget,
) {
  if (!input.redeploy) return null;
  return runCoolifyDeploy({
    projectId: input.projectId,
    integrationId: row.id,
    targetLabels: [target.label],
  });
}
