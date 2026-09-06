import { logger } from '../../logger.js';
import { isSentryEnabled, Sentry } from '../../observability/sentry.js';
import {
  DEPLOY_CONFIRM_WINDOW_MS,
  type DeployConfirmationStatus,
  replaceDispatchHoldWithTargets,
} from '../../pipeline/deploy-confirmations.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { findConnectionById, updateConnection } from '../store.js';
import type {
  HealthCheckResult,
  IntegrationAdapter,
  OutboundDispatchInput,
  OutboundDispatchResult,
} from '../types.js';
import { breakerAllowsDispatch, maybeResetBreaker, maybeTripBreaker } from './circuit-breaker.js';
import { CoolifyApiError } from './client.js';
import { enqueueCoolifyConfirm } from './confirm.js';
import { buildClient } from './log-fetch.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

const BREADCRUMB_OUT = 'integration.coolify.dispatch';

interface DeployPayload extends Record<string, unknown> {
  /** `null` for a run-less resource redeploy (no pipeline run to advance). */
  runId: string | null;
  issueId: string | null;
  environment: 'staging' | 'prod';
  /** The specific target deployed by this delivery (one delivery per target). */
  targetId: string;
  targetLabel: string;
  resourceUuid: string;
}

export const coolifyAdapter: IntegrationAdapter<CoolifyConfig, CoolifySecrets> = {
  provider: 'coolify',
  // cm:guard `canReceiveWebhook` is FALSE and repairing it is not the fix (ISS-922): Coolify's `SendWebhookJob` posts with no headers and no signature, so it can satisfy neither half of the `/in/:slug` contract. `confirm.ts` polls the deployment instead.
  capabilities: {
    canDispatch: true,
    canReceiveWebhook: false,
    injectsMcp: false,
    hasEnvironments: true,
    prodConfirmGate: true,
    hasDeliveryLog: true,
  },

  async healthcheck(ctx) {
    const started = Date.now();
    const client = buildClient(ctx);
    const targets = ctx.config.targets ?? [];
    try {
      if (targets.length === 0) {
        throw new Error('coolify: no deploy targets configured');
      }
      // Verify every configured target resolves to a real Coolify application —
      // a stale/wrong resourceUuid is the classic "deploys the wrong repo" trap,
      // so we surface it per-target rather than only checking the first.
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
      const message = err instanceof Error ? err.message : 'unknown error';
      const status = err instanceof CoolifyApiError ? err.status : null;
      // A 401/403 here means the API token was rejected even after buildClient
      // already retried any valid previous token (ISS-405 rotation window), so
      // the operator must re-enter the credential — surface needs_reauth rather
      // than a generic error (ISS-409). Any other status stays error.
      const healthStatus = status === 401 || status === 403 ? 'needs_reauth' : 'error';
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: healthStatus,
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
        status: healthStatus,
        message,
        diagnostics: { httpStatus: status },
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
    const confirmDeadlineAt = new Date(Date.now() + DEPLOY_CONFIRM_WINDOW_MS).toISOString();
    let firstDeliveryId = '';
    let firstDeploymentUuid: string | undefined;
    let totalDurationMs = 0;
    const failures: { targetLabel: string; message: string; status: number | null }[] = [];

    // cm:edge lockstep -> packages/core/src/pipeline/deploy-confirmations.ts — one hold per target is what makes "the run is proven when EVERY target is" a fact rather than a comment; a fan-out that records a single hold proves the run on its first target.
    const confirmations: {
      deliveryId: string;
      targetLabel: string;
      deploymentUuid: string | null;
      status: DeployConfirmationStatus;
      detail?: string;
    }[] = [];

    for (const target of targets) {
      const targetRequestId = input.requestId ? `${input.requestId}:${target.id}` : undefined;
      const deliveryId = await recordDelivery({
        bindingId: ctx.bindingId,
        direction: 'outbound',
        eventName: input.eventName,
        payload: {
          ...payload,
          runId,
          environment: ctx.environment,
          targetId: target.id,
          targetLabel: target.label,
          resourceUuid: target.resourceUuid,
        },
        ...(targetRequestId ? { requestId: targetRequestId } : {}),
        status: 'pending',
      });
      if (!firstDeliveryId) firstDeliveryId = deliveryId;

      if (isSentryEnabled()) {
        Sentry.addBreadcrumb({
          category: BREADCRUMB_OUT,
          level: 'info',
          message: `coolify deploy dispatch: ${input.eventName} (${target.label})`,
          data: {
            connectionId: ctx.connectionId,
            bindingId: ctx.bindingId,
            environment: ctx.environment,
            deliveryId,
            runId,
            targetId: target.id,
          },
        });
      }

      const started = Date.now();
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
        confirmations.push({
          deliveryId,
          targetLabel: target.label,
          deploymentUuid,
          status: 'pending',
        });
        await enqueueCoolifyConfirm(
          {
            jobKind: 'coolify.confirm',
            bindingId: ctx.bindingId,
            runId,
            deliveryId,
            deploymentUuid,
            targetLabel: target.label,
            deadlineAt: confirmDeadlineAt,
          },
          { startAfterSeconds: 0 },
        );
      } catch (err) {
        const durationMs = Date.now() - started;
        totalDurationMs += durationMs;
        const message = err instanceof Error ? err.message : 'unknown error';
        const status = err instanceof CoolifyApiError ? err.status : null;
        await updateDelivery(deliveryId, {
          status: 'failed',
          errorMessage: message,
          response:
            status !== null ? { httpStatus: status, targetId: target.id } : { targetId: target.id },
          durationMs,
          completedAt: new Date(),
        });
        // Revocation discovered during a deploy (not just the healthcheck): a
        // 401/403 means the token was rejected, so flag needs_reauth (ISS-409).
        if (status === 401 || status === 403) {
          await updateConnection(ctx.connectionId, {
            lastHealthStatus: 'needs_reauth',
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

    if (runId && input.requestId) {
      await replaceDispatchHoldWithTargets({
        runId,
        requestId: input.requestId,
        bindingId: ctx.bindingId,
        targets: confirmations,
      });
    }

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
            environment: ctx.environment,
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

  // cm:guard REFUSE, never accept-and-drop (ISS-922). Coolify's `SendWebhookJob` sends no event header and no signature, so nothing can reach here through `/in/:slug`; a body that somehow does is a provider Forge has not read, and answering it 200 would be a second, unproven writer of run-terminal state beside `confirm.ts`.
  async handleInbound() {
    throw new Error(
      'coolify: inbound webhooks are not supported — Coolify sends no signed callback, so a deploy is confirmed by polling `GET /api/v1/deployments/{uuid}` (see integrations/coolify/confirm.ts)',
    );
  },
};

export function registerCoolifyAdapter(): void {
  if (getAdapter('coolify')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(coolifyAdapter as any);
}
