import type { IntegrationEnvironment } from '../db/schema.js';

export type IntegrationProvider = 'coolify' | 'postman' | 'epodsystem';

export interface AdapterContext<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Owning connection (credential). Health/breaker mutations target this. */
  connectionId: string;
  /** Project+env binding. Deliveries + inbound HMAC are scoped to this. */
  bindingId: string;
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
 * Declares which integration surfaces a provider actually supports, so the UI
 * (and the connection/binding layer) can render to the provider's archetype
 * instead of one rigid layout — e.g. no empty delivery-log box for an
 * MCP-injection provider that never dispatches. See
 * docs/integrations/connection-binding.md.
 *
 * Two archetypes today:
 *  - deploy / 2-way   (coolify): dispatch + inbound webhook + env split + prod gate + delivery log
 *  - MCP-injection    (postman, epodsystem): injects an mcpServers.* entry into the runner; no dispatch
 */
export interface IntegrationCapabilities {
  /** Core makes outbound API calls (e.g. trigger a deploy). */
  canDispatch: boolean;
  /** Core handles an inbound webhook callback from the provider. */
  canReceiveWebhook: boolean;
  /** Injects an `mcpServers.<provider>` entry into the runner at dispatch time. */
  injectsMcp: boolean;
  /** A staging/prod environment split is meaningful for this provider. */
  hasEnvironments: boolean;
  /** A prod-environment action requires an explicit human confirm gate. */
  prodConfirmGate: boolean;
  /** A delivery audit log is meaningful (false for MCP-injection providers). */
  hasDeliveryLog: boolean;
}

/** Conservative default for an adapter that does not declare capabilities. */
export const DEFAULT_CAPABILITIES: IntegrationCapabilities = {
  canDispatch: false,
  canReceiveWebhook: false,
  injectsMcp: false,
  hasEnvironments: false,
  prodConfirmGate: false,
  hasDeliveryLog: false,
};

/** Resolve an adapter's capabilities, falling back to the conservative default. */
export function capabilitiesFor(
  adapter: Pick<IntegrationAdapter, 'capabilities'> | undefined | null,
): IntegrationCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...(adapter?.capabilities ?? {}) };
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
  /**
   * Provider archetype flags. Optional for backward-compatibility (test mocks,
   * the conservative default applies via {@link capabilitiesFor}); all shipped
   * adapters declare it.
   */
  readonly capabilities?: IntegrationCapabilities;
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
