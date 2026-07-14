import { scrubLogText } from '@forge/observability';
import { logger } from '../../logger.js';
import { Sentry, isSentryEnabled } from '../../observability/sentry.js';
import { closeRun, setCurrentStepForce } from '../../pipeline/runs.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import {
  findInboundByDeploymentUuid,
  findOutboundByDeploymentUuid,
  listDispatchedOutboundForRun,
  recordDelivery,
  updateDelivery,
} from '../deliveries.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { isPreviousCredentialValid } from '../rotation.js';
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
import { breakerAllowsDispatch, maybeResetBreaker, maybeTripBreaker } from './circuit-breaker.js';
import { CoolifyApiError, CoolifyClient } from './client.js';
import { flattenLogs, redactCoolifyEnvDump, tailLog } from './logs.js';
import type { CoolifyConfig, CoolifySecrets, CoolifyWebhookPayload } from './types.js';

const BREADCRUMB_OUT = 'integration.coolify.dispatch';
const BREADCRUMB_IN = 'integration.coolify.inbound';

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
    let firstDeliveryId = '';
    let firstDeploymentUuid: string | undefined;
    let totalDurationMs = 0;
    const failures: { targetLabel: string; message: string; status: number | null }[] = [];

    // Fan out one deploy per target (e.g. BE + FE as separate Coolify apps).
    // Each target is its own delivery row so the inbound webhook can map each
    // deployment_uuid back to its run, and the run only advances once ALL
    // targets report success (see handleInbound). The per-target requestId
    // suffix keeps the (binding, requestId) unique index collision-free.
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
        failures.push({ targetLabel: target.label, message, status });
        // Keep deploying the remaining targets — a BE failure shouldn't strand
        // an FE deploy. Aggregate failure is raised after the loop.
      }
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
    //
    // Multi-target aggregation: a binding may deploy several apps (BE + FE) for
    // one run, so this webhook is for ONE target. Fail-fast on any target's
    // failure; only mark the run `done` once EVERY dispatched target has a
    // successful inbound webhook.
    let actions = 0;
    const isFailure = payload.status === 'failed' || payload.event === 'deploy.failed';
    const isSuccess = payload.status === 'success' || payload.event === 'deploy.succeeded';

    if (isFailure) {
      await setCurrentStepForce(runId, 'release.deploy.failed');
      await closeRun(runId, 'failed');
      return { deliveryId, actions: 1 };
    }

    if (isSuccess) {
      const dispatched = await listDispatchedOutboundForRun(ctx.bindingId, runId);
      const expectedUuids = dispatched
        .map((d) => (d.response as { deployment_uuid?: string } | null)?.deployment_uuid)
        .filter((u): u is string => typeof u === 'string' && u.length > 0);

      // Count how many expected targets have a recorded successful inbound. The
      // current webhook's inbound delivery is already persisted above, so it is
      // included in this scan — no special-casing of the current uuid needed.
      let succeeded = 0;
      for (const uuid of expectedUuids) {
        const inb = await findInboundByDeploymentUuid(ctx.bindingId, uuid);
        const p = (inb?.payload ?? null) as CoolifyWebhookPayload | null;
        if (p && (p.status === 'success' || p.event === 'deploy.succeeded')) succeeded++;
      }
      const total = Math.max(expectedUuids.length, 1);

      if (succeeded >= total) {
        await setCurrentStepForce(runId, 'release.deploy.done');
        await closeRun(runId, 'completed');
      } else {
        await setCurrentStepForce(runId, `release.deploy.in_flight (${succeeded}/${total})`);
      }
      return { deliveryId, actions: 1 };
    }

    // Non-terminal progress event for this target.
    await setCurrentStepForce(runId, `release.deploy.${payload.status ?? 'progress'}`);
    actions++;
    return { deliveryId, actions };
  },
};

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
  // ISS-412 — Coolify-specific block redaction first (catches non-suffix env
  // names inside the runtime .env dump), then generic scrubLogText handles
  // suffix-shaped secrets, PATs, header/URL tokens, and extraSecrets residue.
  const preRedacted = redactCoolifyEnvDump(raw);
  const scrubbed = scrubLogText(preRedacted, extraSecrets);
  const { text, truncated } = tailLog(scrubbed);
  return { deploymentUuid, status: dep.status ?? null, logs: text, truncated };
}

export interface CoolifyRuntimeLogsResult {
  resourceUuid: string;
  logs: string;
  /** True when the log was tailed (older lines or leading bytes dropped). */
  truncated: boolean;
}

/**
 * Fetch an application's recent RUNTIME container logs (the live container, not
 * the build log), scrub secrets line-by-line, and tail. Mirrors
 * {@link fetchCoolifyDeploymentLogs} but hits the runtime-logs endpoint.
 * CAVEAT: a docker-compose target returns only ONE container's logs — Coolify's
 * public API has no working per-service selector (see
 * `CoolifyApplicationLogsResponse`). Reliable only for single-container apps.
 */
export async function fetchCoolifyRuntimeLogs(
  pair: BindingWithConnection,
  resourceUuid: string,
  lines?: number,
): Promise<CoolifyRuntimeLogsResult> {
  const ctx = buildContextFromBinding<CoolifyConfig, CoolifySecrets>(pair);
  const client = buildClient(ctx);
  const res = await client.getApplicationLogs(
    resourceUuid,
    lines !== undefined ? { lines } : undefined,
  );
  const raw = typeof res.logs === 'string' ? res.logs : '';
  const extraSecrets = [ctx.secrets.apiToken, ctx.secrets.previousApiToken].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const scrubbed = scrubLogText(redactCoolifyEnvDump(raw), extraSecrets);
  const { text, truncated } = tailLog(scrubbed);
  return { resourceUuid, logs: text, truncated };
}

export function registerCoolifyAdapter(): void {
  if (getAdapter('coolify')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(coolifyAdapter as any);
}
