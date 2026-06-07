import { scrubLogText } from '@forge/observability';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationDeliveries } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { Sentry, isSentryEnabled } from '../../observability/sentry.js';
import { closeRun, setCurrentStepForce } from '../../pipeline/runs.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { getAdapter, registerAdapter } from '../registry.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  findConnectionById,
  updateConnection,
} from '../store.js';
import type {
  HealthCheckResult,
  InboundDispatchInput,
  InboundDispatchResult,
  IntegrationAdapter,
  OutboundDispatchInput,
  OutboundDispatchResult,
} from '../types.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { maybeResetBreaker, maybeTripBreaker } from './circuit-breaker.js';
import { CoolifyApiError, CoolifyClient } from './client.js';
import { flattenLogs, tailLog } from './logs.js';
import type { CoolifyConfig, CoolifySecrets, CoolifyWebhookPayload } from './types.js';

const BREADCRUMB_OUT = 'integration.coolify.dispatch';
const BREADCRUMB_IN = 'integration.coolify.inbound';

interface DeployPayload extends Record<string, unknown> {
  /** `null` for a run-less resource redeploy (no pipeline run to advance). */
  runId: string | null;
  issueId: string | null;
  environment: 'staging' | 'prod';
  resourceUuid: string;
}

function buildClient(ctx: {
  config: CoolifyConfig;
  secrets: CoolifySecrets;
}): CoolifyClient {
  // Honour the 24h rotation window: include previousApiToken only if it
  // hasn't expired yet (validity guard lives in the shared rotation helper).
  const opts: ConstructorParameters<typeof CoolifyClient>[0] = {
    baseUrl: ctx.config.baseUrl,
    apiToken: ctx.secrets.apiToken,
  };
  if (ctx.secrets.previousApiToken && isPreviousCredentialValid(ctx.secrets)) {
    opts.previousApiToken = ctx.secrets.previousApiToken;
  }
  return new CoolifyClient(opts);
}

export const coolifyAdapter: IntegrationAdapter<CoolifyConfig, CoolifySecrets> = {
  provider: 'coolify',
  // Deploy / 2-way archetype: outbound deploy + inbound webhook, env split,
  // prod confirm gate, delivery audit log.
  capabilities: {
    canDispatch: true,
    canReceiveWebhook: true,
    injectsMcp: false,
    hasEnvironments: true,
    prodConfirmGate: true,
    hasDeliveryLog: true,
  },

  async healthcheck(ctx) {
    const started = Date.now();
    const client = buildClient(ctx);
    try {
      const res = await client.getResource(ctx.config.resourceUuid);
      const durationMs = Date.now() - started;
      await updateConnection(ctx.connectionId, {
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
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message, httpStatus: status },
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
    // Refresh the connection to honour any breaker state changes since context
    // was built. If the breaker is open we abort without contacting Coolify.
    const connection = await findConnectionById(ctx.connectionId);
    if (!connection || !connection.active) {
      throw new Error(
        `coolify: connection ${ctx.connectionId} is inactive (circuit breaker open?)`,
      );
    }

    const payload = (input.payload ?? {}) as Partial<DeployPayload>;
    // `runId` is purely a tracking key for the deployment_uuid → run mapping.
    // A run-less resource redeploy (ISS-312) legitimately carries no run, so we
    // coalesce to null and record the delivery with runId:null rather than
    // throwing. The inbound webhook handler already no-ops on a null-run match.
    const runId = payload.runId ?? input.runId ?? null;

    const deliveryId = await recordDelivery({
      bindingId: ctx.bindingId,
      direction: 'outbound',
      eventName: input.eventName,
      payload: {
        ...payload,
        runId,
        environment: ctx.environment,
        resourceUuid: ctx.config.resourceUuid,
      },
      ...(input.requestId ? { requestId: input.requestId } : {}),
      status: 'pending',
    });

    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: BREADCRUMB_OUT,
        level: 'info',
        message: `coolify deploy dispatch: ${input.eventName}`,
        data: {
          connectionId: ctx.connectionId,
          bindingId: ctx.bindingId,
          environment: ctx.environment,
          deliveryId,
          runId,
        },
      });
    }

    const started = Date.now();
    const client = buildClient(ctx);
    try {
      // Always force-rebuild: a release/re-deploy should produce a fresh build
      // even when Coolify thinks the commit is unchanged (ISS-290).
      const res = await client.deploy({ resourceUuid: ctx.config.resourceUuid, force: true });
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
      await maybeResetBreaker(ctx.connectionId);
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
      const tripped = await maybeTripBreaker({
        bindingId: ctx.bindingId,
        connectionId: ctx.connectionId,
      });
      if (tripped) {
        logger.error(
          { connectionId: ctx.connectionId, bindingId: ctx.bindingId, environment: ctx.environment },
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
      bindingId: ctx.bindingId,
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
          connectionId: ctx.connectionId,
          bindingId: ctx.bindingId,
          environment: ctx.environment,
          deploymentUuid,
          status: payload.status ?? null,
        },
      });
    }

    // Locate the original outbound delivery whose Coolify response carried
    // this deployment_uuid. We extract runId from its payload to advance
    // the right pipeline run.
    const outbound = await findOutboundByDeploymentUuid(ctx.bindingId, deploymentUuid);
    if (!outbound) {
      logger.warn(
        { bindingId: ctx.bindingId, deploymentUuid },
        'coolify webhook: no matching outbound delivery — possibly fired for a deploy from another tool',
      );
      return { deliveryId, actions: 0 };
    }

    const outboundPayload = outbound.payload as Partial<DeployPayload> | null;
    const runId = outboundPayload?.runId;
    if (!runId) {
      logger.warn(
        { bindingId: ctx.bindingId, deploymentUuid },
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
  bindingId: string,
  deploymentUuid: string,
): Promise<typeof integrationDeliveries.$inferSelect | null> {
  const rows = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.status, 'ok'),
        sql`response->>'deployment_uuid' = ${deploymentUuid}`,
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface CoolifyDeploymentLogsResult {
  deploymentUuid: string;
  status: string | null;
  logs: string;
  /** True when the log was tailed (older lines or leading bytes dropped). */
  truncated: boolean;
}

/**
 * Fetch a Coolify deployment's build/deploy log, scrub secrets line-by-line,
 * and tail it. Exported standalone (not a method on `coolifyAdapter`) because
 * the `IntegrationAdapter` interface is fixed; the MCP `forge_coolify_deploy`
 * `logs` action calls this directly. Secret VALUES of the integration itself
 * (apiToken / previousApiToken) are passed to the scrubber so a token echoed
 * into the build log is redacted alongside the generic secret-shaped patterns.
 */
export async function fetchCoolifyDeploymentLogs(
  pair: BindingWithConnection,
  deploymentUuid: string,
): Promise<CoolifyDeploymentLogsResult> {
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair);
  const client = buildClient(ctx);
  const dep = await client.getDeployment(deploymentUuid);
  const raw = flattenLogs(dep.logs);
  const extraSecrets = [ctx.secrets.apiToken, ctx.secrets.previousApiToken].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const scrubbed = scrubLogText(raw, extraSecrets);
  const { text, truncated } = tailLog(scrubbed);
  return { deploymentUuid, status: dep.status ?? null, logs: text, truncated };
}

export function registerCoolifyAdapter(): void {
  if (getAdapter('coolify')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(coolifyAdapter as any);
}
