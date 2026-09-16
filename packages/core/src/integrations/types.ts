import type { BindingRole, DeployStage } from '../db/schema.js';

export type IntegrationProvider =
  | 'coolify'
  | 'postman'
  | 'epodsystem'
  | 'sentry'
  | 'rocketchat'
  | 'github'
  | 'google'
  | 'agent';

/** Runtime form of {@link IntegrationProvider} — for validating caller-supplied strings. */
export const INTEGRATION_PROVIDERS = [
  'coolify',
  'postman',
  'epodsystem',
  'sentry',
  'rocketchat',
  'github',
  'google',
  'agent',
] as const satisfies readonly IntegrationProvider[];

/**
 * The providers Forge can push code or content TO, and therefore the only ones a binding may take
 * `role: 'deploy'` on.
 */
export const DEPLOY_CAPABLE_PROVIDERS = [
  'coolify',
  'epodsystem',
  'agent',
] as const satisfies readonly IntegrationProvider[];

export function providerCanDeploy(provider: string): boolean {
  return (DEPLOY_CAPABLE_PROVIDERS as readonly string[]).includes(provider);
}

const _providersExhaustive: IntegrationProvider =
  null as unknown as (typeof INTEGRATION_PROVIDERS)[number];
void _providersExhaustive;

export interface AdapterContext<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Owning connection (credential). Health/breaker mutations target this. */
  connectionId: string;
  /** Per-project binding. Deliveries + inbound HMAC are scoped to this. */
  bindingId: string;
  projectId: string;
  provider: IntegrationProvider;
  role: BindingRole;
  /** Empty for a `service` binding; one or both stages for a `deploy` one. */
  stages: DeployStage[];
  config: TConfig;
  /** Decrypted secrets, lazily decrypted by the dispatch path. */
  secrets: TSecrets;
  /** HMAC secret used to verify inbound webhook signatures, if applicable. */
  integrationSecret: string | null;
}

/**
 * `needs_reauth` (ISS-409 / F4): the provider does NOT RECOGNISE the stored
 * credential — HTTP 401, or an epodsystem GraphQL auth error — AND the ISS-405
 * previous-credential rotation fallback did not recover. The operator must
 * re-enter the credential.
 *
 * `needs_scope` (ISS-924): the provider recognises the credential and REFUSES
 * this route — HTTP 403. The credential is valid and re-entering it reproduces
 * the state exactly; the fix is to widen what the credential is allowed to do.
 * The message names the missing permission and the route that wanted it.
 *
 * `error` covers transient and other failures.
 */
export type HealthStatus = 'ok' | 'degraded' | 'error' | 'needs_reauth' | 'needs_scope';

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
 * MCP-injection provider that never dispatches.
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
  /**
   * Forge can DEPLOY to this provider, so a binding of it may be `role: 'deploy'`
   * and carry stages. Must equal `providerCanDeploy(provider)` — `capabilities.test.ts`
   * asserts the two agree, because a screen that offers a deploy role the create
   * schema then refuses is an affordance defect, not a copy error. The field this
   * replaced was `hasEnvironments`, which asked whether a staging/prod split was
   * meaningful; the split is gone and the question it was standing in for is this one.
   */
  canDeploy: boolean;
  /** An action on a LIVE stage requires an explicit human confirm gate. */
  liveConfirmGate: boolean;
  /** A delivery audit log is meaningful (false for MCP-injection providers). */
  hasDeliveryLog: boolean;
}

/** Conservative default for an adapter that does not declare capabilities. */
export const DEFAULT_CAPABILITIES: IntegrationCapabilities = {
  canDispatch: false,
  canReceiveWebhook: false,
  injectsMcp: false,
  canDeploy: false,
  liveConfirmGate: false,
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
