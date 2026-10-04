import { logger } from '../../observability/logger.js';
import { traceStep } from '../../observability/sentry.js';
import {
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
} from '../index.js';
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
    // Refresh the connection to honour any breaker state changes since context
    // was built. If the breaker is open we abort without contacting Coolify.
    const connection = await findConnectionById(ctx.connectionId);
    if (!connection) {
      throw new Error(`coolify: connection ${ctx.connectionId} not found`);
    }
    // Breaker gate: allow when closed, or as a half-open trial once the cooldown
    // has elapsed (a successful trial below resets the breaker). Still-cooling →
    // abort. This is what lets an open breaker ever recover via dispatch.
    const gate = await breakerAllowsDispatch(connection);
    if (!gate.allow) {
      throw new Error(
        `coolify: connection ${ctx.connectionId} is inactive (circuit breaker open; retry after cooldown or Test-connection to reset)`,
      );
    }

    const payload = (input.payload ?? {}) as Partial<DeployPayload>;
    // `runId` is purely a tracking key for the deployment_uuid → run mapping.
    // A run-less resource redeploy (ISS-312) legitimately carries no run, so we
    // coalesce to null and record the delivery with runId:null rather than
    // throwing. The inbound webhook handler already no-ops on a null-run match.
    const runId = payload.runId ?? input.runId ?? null;

    const targets = ctx.config.targets ?? [];
    if (targets.length === 0) {
      throw new Error(`coolify: binding ${ctx.bindingId} has no deploy targets configured`);
    }

    const client = buildClient(ctx);
    let firstDeliveryId = '';
    let firstDeploymentUuid: string | undefined;
    let totalDurationMs = 0;
    const failures: { targetLabel: string; message: string; status: number | null }[] = [];

    const confirmations: DeployTargetDispatch[] = [];

    // Held rather than thrown, so the bookkeeping below runs on this path too.
    let fanOutError: unknown;
    try {
      for (const target of targets) {
        const targetRequestId = input.requestId ? `${input.requestId}:${target.id}` : undefined;
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
          ...(targetRequestId ? { requestId: targetRequestId } : {}),
          status: 'pending',
        });
        if (!firstDeliveryId) firstDeliveryId = deliveryId;

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
        let accepted: string | undefined;
        try {
          // Always force-rebuild: a release/re-deploy should produce a fresh build
          // even when Coolify thinks the commit is unchanged (ISS-290).
          const res = await client.deploy({ resourceUuid: target.resourceUuid, force: true });
          // Coolify v4 returns a `deployments[]` array; older versions a top-level
          // deployment_uuid. Resolve either and fail loudly if neither is present.
          const deploymentUuid = res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid;
          if (!deploymentUuid) {
            throw new Error('coolify deploy: response carried no deployment_uuid');
          }
          // Coolify is building it from here, so the outcome records it BEFORE the delivery row is
          // persisted: a write that fails afterwards must not leave the dispatch reporting a set of
          // targets that omits a deploy now running, which reads as an idle environment and frees
          // the hold under it (ISS-1279).
          accepted = deploymentUuid;
          confirmations.push({
            deliveryId,
            targetLabel: target.label,
            deploymentUuid,
            status: 'pending',
          });
          const durationMs = Date.now() - started;
          totalDurationMs += durationMs;
          if (!firstDeploymentUuid) firstDeploymentUuid = deploymentUuid;
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
          // A deploy Coolify accepted cannot be re-recorded as a refusal: the failure is the
          // delivery row's, and it ends the fan-out loudly rather than rewriting what is running.
          if (accepted) throw err;
          const durationMs = Date.now() - started;
          totalDurationMs += durationMs;
          const status = err instanceof CoolifyApiError ? err.status : null;
          const message = describeCoolifyFailure(err);
          await updateDelivery(deliveryId, {
            status: 'failed',
            errorMessage: message,
            response:
              status !== null
                ? { httpStatus: status, targetId: target.id }
                : { targetId: target.id },
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
          confirmations.push({
            deliveryId,
            targetLabel: target.label,
            deploymentUuid: null,
            status: 'failed',
            detail: message,
          });
          failures.push({ targetLabel: target.label, message, status });
          // Keep deploying the remaining targets — a BE failure shouldn't strand
          // an FE deploy. Aggregate failure is raised after the loop.
        }
      }
    } catch (err) {
      fanOutError = err;
    }

    await input.onDeployOutcome?.({
      runId,
      bindingId: ctx.bindingId,
      targets: confirmations,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    if (fanOutError) throw fanOutError;

    if (failures.length > 0) {
      const tripped = await maybeTripBreaker({
        bindingId: ctx.bindingId,
        connectionId: ctx.connectionId,
      });
      if (tripped) {
        logger.error(
          {
            connectionId: ctx.connectionId,
            bindingId: ctx.bindingId,
          },
          'coolify: circuit breaker tripped — ops follow-up required',
        );
      }
      const detail = failures.map((f) => `${f.targetLabel}: ${f.message}`).join('; ');
      throw new Error(
        `coolify deploy failed for ${failures.length}/${targets.length} target(s): ${detail}`,
      );
    }

    await maybeResetBreaker(ctx.connectionId);
    // A successful deploy dispatch IS a health signal (API reachable + token
    // accepted) — record it so the card can't stay stuck on a stale `error`
    // from a one-off healthcheck while deploys keep succeeding (ISS-429).
    await updateConnection(ctx.connectionId, {
      lastHealthStatus: 'ok',
      lastHealthAt: new Date(),
    });
    return {
      deliveryId: firstDeliveryId,
      ...(firstDeploymentUuid ? { externalId: firstDeploymentUuid } : {}),
      durationMs: totalDurationMs,
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
