import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationDeliveries } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { isSentryEnabled, Sentry } from '../../observability/sentry.js';
import { closeRun, setCurrentStepForce } from '../../pipeline/runs.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { findById, updateIntegration } from '../store.js';
import type {
  HealthCheckResult,
  InboundDispatchInput,
  InboundDispatchResult,
  IntegrationAdapter,
  OutboundDispatchInput,
  OutboundDispatchResult,
} from '../types.js';
import { CoolifyApiError, CoolifyClient } from './client.js';
import { maybeResetBreaker, maybeTripBreaker } from './circuit-breaker.js';
import type { CoolifyConfig, CoolifySecrets, CoolifyWebhookPayload } from './types.js';

const BREADCRUMB_OUT = 'integration.coolify.dispatch';
const BREADCRUMB_IN = 'integration.coolify.inbound';

interface DeployPayload extends Record<string, unknown> {
  runId: string;
  issueId: string | null;
  environment: 'staging' | 'prod';
  resourceUuid: string;
}

function buildClient(ctx: {
  config: CoolifyConfig;
  secrets: CoolifySecrets;
}): CoolifyClient {
  // Honour the 24h rotation window: include previousApiToken only if it
  // hasn't expired yet.
  const previousValid =
    !!ctx.secrets.previousApiToken &&
    (!ctx.secrets.previousTokenExpiresAt ||
      Date.parse(ctx.secrets.previousTokenExpiresAt) > Date.now());
  const opts: ConstructorParameters<typeof CoolifyClient>[0] = {
    baseUrl: ctx.config.baseUrl,
    apiToken: ctx.secrets.apiToken,
  };
  if (previousValid && ctx.secrets.previousApiToken) {
    opts.previousApiToken = ctx.secrets.previousApiToken;
  }
  return new CoolifyClient(opts);
}

export const coolifyAdapter: IntegrationAdapter<CoolifyConfig, CoolifySecrets> = {
  provider: 'coolify',

  async healthcheck(ctx) {
    const started = Date.now();
    const client = buildClient(ctx);
    try {
      const res = await client.getResource(ctx.config.resourceUuid);
      const durationMs = Date.now() - started;
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: res.name ? `Reached resource "${res.name}"` : 'Resource reachable',
        diagnostics: { durationMs, status: res.status ?? null },
      } satisfies HealthCheckResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      const status = err instanceof CoolifyApiError ? err.status : null;
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      logger.warn(
        { integrationId: ctx.integrationId, err: message, httpStatus: status },
        'coolify: healthcheck failed',
      );
      return {
        status: 'error',
        message,
        diagnostics: { httpStatus: status },
      } satisfies HealthCheckResult;
    }
  },

  async dispatchOutbound(ctx, input: OutboundDispatchInput): Promise<OutboundDispatchResult> {
    // Refresh row to honour any breaker state changes since context was
    // built. If the breaker is open we abort without contacting Coolify.
    const row = await findById(ctx.integrationId);
    if (!row || !row.active) {
      throw new Error(
        `coolify: integration ${ctx.integrationId} is inactive (circuit breaker open?)`,
      );
    }

    const payload = (input.payload ?? {}) as Partial<DeployPayload>;
    const runId = payload.runId ?? input.runId ?? '';
    if (!runId) {
      throw new Error('coolify dispatch: runId is required');
    }

    const deliveryId = await recordDelivery({
      projectIntegrationId: ctx.integrationId,
      direction: 'outbound',
      eventName: input.eventName,
      payload: { ...payload, runId, environment: ctx.environment, resourceUuid: ctx.config.resourceUuid },
      ...(input.requestId ? { requestId: input.requestId } : {}),
      status: 'pending',
    });

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: BREADCRUMB_OUT,
        level: 'info',
        message: `coolify deploy dispatch: ${input.eventName}`,
        data: {
          integrationId: ctx.integrationId,
          environment: ctx.environment,
          deliveryId,
          runId,
        },
      });
    }

    const started = Date.now();
    const client = buildClient(ctx);
    try {
      const res = await client.deploy({ resourceUuid: ctx.config.resourceUuid });
      // Coolify v4 returns a `deployments[]` array; older versions a top-level
      // deployment_uuid. Resolve either and fail loudly if neither is present.
      const deploymentUuid = res.deployments?.[0]?.deployment_uuid ?? res.deployment_uuid;
      if (!deploymentUuid) {
        throw new Error('coolify deploy: response carried no deployment_uuid');
      }
      const durationMs = Date.now() - started;
      await updateDelivery(deliveryId, {
        status: 'ok',
        response: { deployment_uuid: deploymentUuid, message: res.message ?? null },
        durationMs,
        completedAt: new Date(),
      });
      await maybeResetBreaker(ctx.integrationId);
      return { deliveryId, externalId: deploymentUuid, durationMs };
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : 'unknown error';
      const status = err instanceof CoolifyApiError ? err.status : null;
      await updateDelivery(deliveryId, {
        status: 'failed',
        errorMessage: message,
        response: status !== null ? { httpStatus: status } : null,
        durationMs,
        completedAt: new Date(),
      });
      const tripped = await maybeTripBreaker(ctx.integrationId);
      if (tripped) {
        logger.error(
          { integrationId: ctx.integrationId, environment: ctx.environment },
          'coolify: circuit breaker tripped — ops follow-up required',
        );
      }
      throw err;
    }
  },

  async handleInbound(ctx, input: InboundDispatchInput): Promise<InboundDispatchResult> {
    const signature =
      input.headers['x-coolify-signature-256'] ??
      input.headers['x-hub-signature-256'] ??
      input.headers['x-forge-signature-256'] ??
      null;

    if (!ctx.integrationSecret) {
      throw new Error('coolify: integration has no signing secret configured');
    }
    if (!verifyHmacSignature(ctx.integrationSecret, input.rawBody, signature)) {
      throw new Error('coolify: signature verification failed');
    }

    const payload = input.payload as CoolifyWebhookPayload;
    const deploymentUuid = payload?.deployment_uuid;
    if (!deploymentUuid) {
      throw new Error('coolify webhook: deployment_uuid missing from payload');
    }

    const deliveryId = await recordDelivery({
      projectIntegrationId: ctx.integrationId,
      direction: 'inbound',
      eventName: payload.event ?? 'coolify.unknown',
      payload,
      requestId: deploymentUuid,
      status: 'ok',
    });

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: BREADCRUMB_IN,
        level: 'info',
        message: `coolify webhook: ${payload.event ?? '<no event>'}`,
        data: {
          integrationId: ctx.integrationId,
          environment: ctx.environment,
          deploymentUuid,
          status: payload.status ?? null,
        },
      });
    }

    // Locate the original outbound delivery whose Coolify response carried
    // this deployment_uuid. We extract runId from its payload to advance
    // the right pipeline run.
    const outbound = await findOutboundByDeploymentUuid(ctx.integrationId, deploymentUuid);
    if (!outbound) {
      logger.warn(
        { integrationId: ctx.integrationId, deploymentUuid },
        'coolify webhook: no matching outbound delivery — possibly fired for a deploy from another tool',
      );
      return { deliveryId, actions: 0 };
    }

    const outboundPayload = outbound.payload as Partial<DeployPayload> | null;
    const runId = outboundPayload?.runId;
    if (!runId) {
      logger.warn(
        { integrationId: ctx.integrationId, deploymentUuid },
        'coolify webhook: matched outbound delivery has no runId — cannot advance pipeline',
      );
      return { deliveryId, actions: 0 };
    }

    // The issue state-machine closes the run before this point, so we stamp
    // currentStep with the forced variant. closeRun is still called for the
    // edge case where the run is somehow still open (e.g. webhook arrives
    // before the release skill finalises the issue transition).
    let actions = 0;
    if (payload.status === 'success' || payload.event === 'deploy.succeeded') {
      await setCurrentStepForce(runId, 'release.deploy.done');
      await closeRun(runId, 'completed');
      actions++;
    } else if (payload.status === 'failed' || payload.event === 'deploy.failed') {
      await setCurrentStepForce(runId, 'release.deploy.failed');
      await closeRun(runId, 'failed');
      actions++;
    } else {
      await setCurrentStepForce(runId, `release.deploy.${payload.status ?? 'progress'}`);
      actions++;
    }

    return { deliveryId, actions };
  },
};

async function findOutboundByDeploymentUuid(
  projectIntegrationId: string,
  deploymentUuid: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.projectIntegrationId, projectIntegrationId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, 'ok'),
        sql`response->>'deployment_uuid' = ${deploymentUuid}`,
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export function registerCoolifyAdapter(): void {
  if (getAdapter('coolify')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(coolifyAdapter as any);
}
