import { traceStep } from '../../../lib/error-tracking.js';
import { logger } from '../../../lib/logger.js';
import {
  type AdapterContext,
  type DeployTargetDispatch,
  type DispatchingAdapterMethods,
  declareIntegration,
  findConnectionById,
  type HealthCheckResult,
  type OutboundDispatchInput,
  type OutboundDispatchResult,
  recordDelivery,
  updateConnection,
  updateDelivery,
} from '../../index.js';
import { verifyCoolifyBindingTarget } from './binding-target.js';
import { breakerAllowsDispatch, maybeResetBreaker, maybeTripBreaker } from './circuit-breaker.js';
import { CoolifyApiError, coolifyAbilityForRoute, describeCoolifyForbidden } from './client.js';
import { coolifyDeploymentRecords } from './deployment-records.js';
import { buildClient } from './log-fetch.js';
import {
  COOLIFY_BINDING_CONFIG_KEYS,
  COOLIFY_BINDING_ONLY_CONFIG_KEYS,
  coolifyConfigSchema,
  coolifyConnectionConfigSchema,
  coolifyConnectionPatchConfigSchema,
  coolifySecretsSchema,
} from './schemas.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

const BREADCRUMB_OUT = 'integration.coolify.dispatch';

interface DeployPayload extends Record<string, unknown> {
  /** `null` for a run-less resource redeploy (no pipeline run to advance). */
  runId: string | null;
  issueId: string | null;
  /** The specific target deployed by this delivery (one delivery per target). */
  targetId: string;
  targetLabel: string;
  resourceUuid: string;
}

interface CoolifyFailureVerdict {
  health: 'needs_reauth' | 'needs_scope' | 'error';
  /** Operator-facing sentence for a 403; `null` leaves the raw error message. */
  message: string | null;
  route: string | null;
  missingAbility: string | null;
}

/**
 * Which health state a failed Coolify call earns. 401 and 403 are DIFFERENT
 * conditions and the only place they can still be told apart is here, at the
 * call that failed (ISS-924).
 */
function classifyCoolifyFailure(err: unknown): CoolifyFailureVerdict {
  const status = err instanceof CoolifyApiError ? err.status : null;
  const route = err instanceof CoolifyApiError ? err.route : null;
  if (status === 401) {
    return { health: 'needs_reauth', message: null, route, missingAbility: null };
  }
  if (status === 403 && err instanceof CoolifyApiError) {
    return {
      health: 'needs_scope',
      message: describeCoolifyForbidden(err),
      route,
      missingAbility: coolifyAbilityForRoute(route),
    };
  }
  return { health: 'error', message: null, route, missingAbility: null };
}

/** The message a failure is recorded and reported under. */
function describeCoolifyFailure(err: unknown): string {
  const verdict = classifyCoolifyFailure(err);
  if (verdict.message) return verdict.message;
  return err instanceof Error ? err.message : 'unknown error';
}

interface TargetOutcome {
  confirmation: DeployTargetDispatch;
  durationMs: number;
}

/**
 * One target's deploy: its own delivery row, a forced rebuild (a release must build fresh even when
 * Coolify thinks the commit is unchanged, ISS-290), and a refusal recorded rather than thrown so the
 * remaining targets still deploy. A deploy Coolify accepted is recorded before its delivery row is
 * written and is never rewritten as a refusal: a write failing afterwards ends the fan-out loudly
 * instead of reporting a running deploy as absent (ISS-1279).
 */
async function deployTarget(
  args: {
    ctx: AdapterContext<CoolifyConfig, CoolifySecrets>;
    input: OutboundDispatchInput;
    client: ReturnType<typeof buildClient>;
    payload: Partial<DeployPayload>;
    runId: string | null;
    target: CoolifyConfig['targets'] extends readonly (infer T)[] | undefined ? T : never;
  },
  outcomes: TargetOutcome[],
): Promise<void> {
  const { ctx, input, client, payload, runId, target } = args;
  const requestId = input.requestId ? `${input.requestId}:${target.id}` : undefined;
  const deliveryId = await recordDelivery({
    bindingId: ctx.bindingId,
    direction: 'outbound',
    eventName: input.eventName,
    payload: {
      ...payload,
      runId,
      targetId: target.id,
      targetLabel: target.label,
      resourceUuid: target.resourceUuid,
    },
    ...(requestId ? { requestId } : {}),
    status: 'pending',
  });
  traceStep({
    category: BREADCRUMB_OUT,
    level: 'info',
    message: `coolify deploy dispatch: ${input.eventName} (${target.label})`,
    data: {
      connectionId: ctx.connectionId,
      bindingId: ctx.bindingId,
      deliveryId,
      runId,
      targetId: target.id,
    },
  });

  const started = Date.now();
  let accepted = false;
  try {
    const res = await client.deploy({ resourceUuid: target.resourceUuid, force: true });
    // Coolify v4 answers `deployments[]`; older versions a top-level deployment_uuid.
    const deploymentUuid = res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid;
    if (!deploymentUuid) throw new Error('coolify deploy: response carried no deployment_uuid');
    accepted = true;
    const durationMs = Date.now() - started;
    outcomes.push({
      confirmation: { deliveryId, targetLabel: target.label, deploymentUuid, status: 'pending' },
      durationMs,
    });
    await updateDelivery(deliveryId, {
      status: 'ok',
      response: {
        deployment_uuid: deploymentUuid,
        targetId: target.id,
        message: res.message ?? null,
      },
      durationMs,
      completedAt: new Date(),
    });
  } catch (err) {
    if (accepted) throw err;
    const durationMs = Date.now() - started;
    const status = err instanceof CoolifyApiError ? err.status : null;
    const message = describeCoolifyFailure(err);
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: message,
      response:
        status !== null ? { httpStatus: status, targetId: target.id } : { targetId: target.id },
      durationMs,
      completedAt: new Date(),
    });
    const verdict = classifyCoolifyFailure(err);
    if (verdict.health !== 'error') {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: verdict.health,
        lastHealthAt: new Date(),
      });
    }
    outcomes.push({
      confirmation: {
        deliveryId,
        targetLabel: target.label,
        deploymentUuid: null,
        status: 'failed',
        detail: message,
      },
      durationMs,
    });
  }
}

const coolifyAdapterMethods: DispatchingAdapterMethods<CoolifyConfig, CoolifySecrets> = {
  verifyBindingTarget: verifyCoolifyBindingTarget,
  async healthcheck(ctx) {
    const started = Date.now();
    const client = buildClient(ctx);
    const targets = ctx.config.targets ?? [];
    try {
      if (targets.length === 0) {
        throw new Error('coolify: no deploy targets configured');
      }
      const names: string[] = [];
      for (const t of targets) {
        const res = await client.getResource(t.resourceUuid);
        names.push(res.name ? `${t.label} → "${res.name}"` : `${t.label} → ${t.resourceUuid}`);
      }
      const durationMs = Date.now() - started;
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      // A successful Test-connection is an explicit operator signal that the
      // connection is healthy again — clear an open breaker so dispatch (and the
      // pipeline auto-deploy) can resume without waiting for the cooldown.
      await maybeResetBreaker(ctx.connectionId);
      return {
        status: 'ok',
        message:
          targets.length === 1
            ? `Reached ${names[0]}`
            : `Reached ${targets.length} resources: ${names.join(', ')}`,
        diagnostics: { durationMs, targetCount: targets.length },
      } satisfies HealthCheckResult;
    } catch (err) {
      const status = err instanceof CoolifyApiError ? err.status : null;
      const verdict = classifyCoolifyFailure(err);
      const message = verdict.message ?? (err instanceof Error ? err.message : 'unknown error');
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: verdict.health,
        lastHealthAt: new Date(),
      });
      logger.warn(
        {
          connectionId: ctx.connectionId,
          bindingId: ctx.bindingId,
          err: message,
          httpStatus: status,
        },
        'coolify: healthcheck failed',
      );
      return {
        status: verdict.health,
        message,
        diagnostics: {
          httpStatus: status,
          ...(verdict.route ? { route: verdict.route } : {}),
          ...(verdict.missingAbility ? { missingAbility: verdict.missingAbility } : {}),
        },
      } satisfies HealthCheckResult;
    }
  },

  async dispatchOutbound(ctx, input: OutboundDispatchInput): Promise<OutboundDispatchResult> {
    // The breaker is read fresh: closed, or a half-open trial once the cooldown has elapsed (a
    // successful trial resets it). Still cooling aborts without contacting Coolify.
    const connection = await findConnectionById(ctx.connectionId);
    if (!connection) throw new Error(`coolify: connection ${ctx.connectionId} not found`);
    if (!(await breakerAllowsDispatch(connection)).allow) {
      throw new Error(
        `coolify: connection ${ctx.connectionId} is inactive (circuit breaker open; retry after cooldown or Test-connection to reset)`,
      );
    }

    const payload = (input.payload ?? {}) as Partial<DeployPayload>;
    // A run-less resource redeploy (ISS-312) carries no run; the delivery records runId null.
    const runId = payload.runId ?? input.runId ?? null;
    const targets = ctx.config.targets ?? [];
    if (targets.length === 0) {
      throw new Error(`coolify: binding ${ctx.bindingId} has no deploy targets configured`);
    }

    const client = buildClient(ctx);
    const outcomes: TargetOutcome[] = [];
    // Held rather than thrown, so the outcome is reported on this path too.
    let fanOutError: unknown;
    try {
      for (const target of targets) {
        await deployTarget({ ctx, input, client, payload, runId, target }, outcomes);
      }
    } catch (err) {
      fanOutError = err;
    }

    await input.onDeployOutcome?.({
      runId,
      bindingId: ctx.bindingId,
      targets: outcomes.map((o) => o.confirmation),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    if (fanOutError) throw fanOutError;

    const failures = outcomes.filter((o) => o.confirmation.status === 'failed');
    if (failures.length > 0) {
      if (await maybeTripBreaker({ bindingId: ctx.bindingId, connectionId: ctx.connectionId })) {
        logger.error(
          { connectionId: ctx.connectionId, bindingId: ctx.bindingId },
          'coolify: circuit breaker tripped — ops follow-up required',
        );
      }
      const detail = failures
        .map((f) => `${f.confirmation.targetLabel}: ${f.confirmation.detail}`)
        .join('; ');
      throw new Error(
        `coolify deploy failed for ${failures.length}/${targets.length} target(s): ${detail}`,
      );
    }

    await maybeResetBreaker(ctx.connectionId);
    // A deploy Coolify accepted is a health signal too, so the card cannot stay on a stale `error`
    // from a one-off healthcheck while deploys succeed (ISS-429).
    await updateConnection(ctx.connectionId, { lastHealthStatus: 'ok', lastHealthAt: new Date() });
    const first = outcomes.find((o) => o.confirmation.deploymentUuid)?.confirmation.deploymentUuid;
    return {
      deliveryId: outcomes[0]?.confirmation.deliveryId ?? '',
      ...(first ? { externalId: first } : {}),
      durationMs: outcomes.reduce((sum, o) => sum + o.durationMs, 0),
    };
  },

  deploymentRecords: coolifyDeploymentRecords,

  async handleInbound() {
    throw new Error(
      'coolify: inbound webhooks are not supported — Coolify sends no signed callback, so a deploy is confirmed by polling `GET /api/v1/deployments/{uuid}` (see release-batch/coolify-confirm.ts)',
    );
  },
};

/**
 * Coolify's declaration. An agent reaches it only through `forge_coolify_deploy`, which core
 * performs: the API token never leaves core, so the grant on a coolify binding widens who may ask
 * core to deploy rather than who holds the credential.
 */
export const coolifyIntegration = declareIntegration<CoolifyConfig, CoolifySecrets>({
  provider: 'coolify',
  capabilities: {
    canDispatch: true,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    canDeploy: true,
    liveConfirmGate: true,
    hasDeliveryLog: true,
    multiBinding: false,
    // Coolify's API has a rollback endpoint, so a rollback here is an ACTION and not a note for a
    // human — which is why the release batch refuses free text on a coolify channel.
    structuredRollback: true,
    agentPath: { kind: 'permission', tools: ['forge_coolify_deploy'], permission: 'deploys.run' },
  },
  schemas: {
    connectionConfig: coolifyConnectionConfigSchema,
    connectionPatchConfig: coolifyConnectionPatchConfigSchema,
    bindingConfig: coolifyConfigSchema,
    patchConfig: coolifyConfigSchema.partial(),
    secrets: coolifySecretsSchema,
    patchSecrets: coolifySecretsSchema.partial(),
    primaryCredentialField: 'apiToken',
    previousCredentialField: 'previousApiToken',
    independentSecretFields: [],
    bindingConfigKeys: COOLIFY_BINDING_CONFIG_KEYS,
    bindingOnlyConfigKeys: COOLIFY_BINDING_ONLY_CONFIG_KEYS,
  },
  usage: {
    hint: 'Deploy / redeploy and poll deployment status via the `forge_coolify_deploy` tool.',
    guideSlug: 'deploy-safety',
  },
  presentation: {
    label: 'Coolify',
    // Coolify is environment-split by design, so even a single binding keys by environment.
    alwaysEnvironmentKeyed: true,
    neverCheckedDetail: 'never health-checked',
  },
  adapter: coolifyAdapterMethods,
});
