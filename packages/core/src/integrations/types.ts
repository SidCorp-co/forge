import type { IntegrationEnvironment } from '../db/schema.js';

export type IntegrationProvider = 'coolify';

export interface AdapterContext<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  integrationId: string;
  projectId: string;
  provider: IntegrationProvider;
  environment: IntegrationEnvironment;
  config: TConfig;
  /** Decrypted secrets, lazily decrypted by the dispatch path. */
  secrets: TSecrets;
  /** HMAC secret used to verify inbound webhook signatures, if applicable. */
  integrationSecret: string | null;
}

export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  /** Free-form diagnostic data — surfaced to operators in the test-connection UI. */
  diagnostics?: Record<string, unknown>;
}

export interface OutboundDispatchInput<TPayload = unknown> {
  eventName: string;
  payload: TPayload;
  /** Optional dedup key shared with integration_deliveries.request_id. */
  requestId?: string;
  /** Pipeline-run correlation; allows inbound handler to advance the right run.
   *  `null` for a run-less resource redeploy (no pipeline run to advance). */
  runId?: string | null;
}

export interface OutboundDispatchResult {
  deliveryId: string;
  externalId?: string;
  durationMs: number;
}

export interface InboundDispatchInput {
  headers: Record<string, string | undefined>;
  rawBody: string;
  payload: unknown;
}

export interface InboundDispatchResult {
  deliveryId: string;
  actions: number;
}

/**
 * Adapters implement this. Only three methods are required for ISS-234;
 * validateConfig + pollState are intentionally deferred to follow-up issues.
 */
export interface IntegrationAdapter<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly provider: IntegrationProvider;
  healthcheck(ctx: AdapterContext<TConfig, TSecrets>): Promise<HealthCheckResult>;
  dispatchOutbound(
    ctx: AdapterContext<TConfig, TSecrets>,
    input: OutboundDispatchInput,
  ): Promise<OutboundDispatchResult>;
  handleInbound(
    ctx: AdapterContext<TConfig, TSecrets>,
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult>;
}
