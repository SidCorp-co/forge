import type { z } from 'zod';
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

export class NonRetryableDispatchError extends Error {
  constructor(
    message: string,
    /** What refused it, for the log line. Never a retry hint. */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'NonRetryableDispatchError';
  }
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
  refusal?: string;
}

export type AgentPath =
  | { readonly kind: 'none' }
  | { readonly kind: 'core-mediated'; readonly tools: readonly string[] }
  | {
      readonly kind: 'direct-mcp';
      readonly tools: readonly string[];
      /** Base MCP server name. A `multiBinding` provider suffixes it per label. */
      readonly serverName: string;
      /** Why this provider offers no core-mediated route. Read by the declaration checker. */
      readonly justification: string;
      readonly previewSecrets: Record<string, unknown>;
      /** Renders the runner's `mcpServers` entry. Returns null when the credential is unusable. */
      buildEntry(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
      ): Record<string, unknown> | null;
    };

export type AgentPathKind = AgentPath['kind'];

/** The shape every provider that is not `direct-mcp` takes when it does not say otherwise. */
export const CORE_MEDIATED_BY_DEFAULT: AgentPath = { kind: 'core-mediated', tools: [] };

/**
 * Declares which integration surfaces a provider actually supports, so the UI, the connection and
 * binding layer, and every dispatch path can render and decide to the provider's archetype instead
 * of naming the provider.
 *
 * Every field is required. Until ISS-1071 the whole object was optional behind an all-false
 * fallback, which meant an adapter that forgot to declare was read as inert by every generic path
 * and said nothing — and five of seven adapters reached the registry through `as any` because the
 * interface did not fit them.
 */
export interface IntegrationCapabilities {
  /** Core makes outbound API calls (e.g. trigger a deploy). */
  canDispatch: boolean;
  /** Core handles an inbound webhook callback from the provider. */
  canReceiveWebhook: boolean;
  /**
   * Forge can DEPLOY to this provider, so a binding of it may be `role: 'deploy'`
   * and carry stages. Must equal `providerCanDeploy(provider)` — `capabilities.test.ts`
   * asserts the two agree, because a screen that offers a deploy role the create
   * schema then refuses is an affordance defect, not a copy error.
   */
  canDeploy: boolean;
  /** An action on a LIVE stage requires an explicit human confirm gate. */
  liveConfirmGate: boolean;
  /** A delivery audit log is meaningful (false for a provider that never dispatches). */
  hasDeliveryLog: boolean;
  /**
   * One project may hold several bindings of this provider, each reaching a different thing, and
   * each renders its own MCP server entry named from its `label`. False means the oldest active
   * binding wins the one slot and the rest are shadowed.
   */
  multiBinding: boolean;
  /**
   * The request header that identifies an inbound webhook as this provider's.
   *
   * Declared rather than mapped, because the map it replaced lived in
   * `webhooks/inbound-routes.ts` — a file with no other reason to know a provider exists, and one
   * that would keep routing correctly for the providers it already listed while silently dropping a
   * new one on the floor. Only meaningful where `canReceiveWebhook` is true.
   */
  webhookHeader?: string;
  webhookSignatureHeader?: string;
  /**
   * True where this provider's API can express a rollback as a structured action rather than as
   * prose for a human to carry out. Read by `release-batch/channel.ts`, which classified it with
   * `provider === 'coolify'` until ISS-1071.
   */
  structuredRollback: boolean;
  /** How an agent reaches this provider, and at whose risk. */
  agentPath: AgentPath;
}

/**
 * Everything the generic request paths need to validate a caller's body for this provider, in the
 * provider's own directory rather than in a discriminated union that repeats the provider list.
 */
export interface IntegrationSchemas {
  /** Owner-scoped connection create: the credential tier's config. */
  connectionConfig: z.ZodTypeAny;
  /** Project-scoped binding create: config carrying both tiers, split by `bindingConfigKeys`. */
  bindingConfig: z.ZodTypeAny;
  /** The partial of `bindingConfig` a PATCH validates against. */
  patchConfig: z.ZodTypeAny;
  secrets: z.ZodTypeAny;
  /** The partial of `secrets` a PATCH validates against. */
  patchSecrets: z.ZodTypeAny;
  /**
   * The field holding the rotating primary credential, or null where the provider stores none.
   * `rotation.ts` reads this instead of its own per-provider table.
   */
  primaryCredentialField: string | null;
  /** The field retaining the previous credential during the rotation overlap window. */
  previousCredentialField: string | null;
  /**
   * Secret fields a PATCH may write ON THEIR OWN, without the primary credential being rotated.
   * Rocket.Chat's bot `userId` is the only one today: it travels with the token but changing it
   * alone is a legitimate edit. Everything not listed here is written only as part of a rotation,
   * so a PATCH naming one field of a credential set is not mistaken for a credential change.
   */
  independentSecretFields: readonly string[];
  /** Config keys that live on the BINDING rather than the shared connection. */
  bindingConfigKeys: readonly string[];
}

/**
 * How this provider renders as a status card, or `null` where it has no card of its own.
 *
 * ISS-1071 moved this off `status-service.ts`, which carried six hand-written blocks differing only
 * in these four values — so adding a provider meant editing a file that had no other reason to know
 * one existed. `github` declares `null` because its card is built from the project's repository
 * rather than from a binding, and `agent` because a release channel is not an integration to show.
 */
export interface IntegrationPresentation {
  /** Human label on the card. */
  label: string;
  /** Key every card by stage even where there is one binding, because the provider is stage-split
   *  by design. Others keep the bare key until a second binding appears, which keeps an existing
   *  drill-in's bookmark working. */
  alwaysStageKeyed: boolean;
  /** What the card says when the connection has never been health-checked. */
  neverCheckedDetail: string;
  /** Non-secret config fields this provider's card surfaces. Never a credential. */
  cardMeta?: (config: Record<string, unknown>) => Record<string, unknown>;
}

/** The short router hint and forward pointer injected into the preamble when this is reachable. */
/** The connection row shape `inboundSecret` reads — kept structural so `types.ts` imports no db. */
export interface IntegrationConnectionLike {
  secretsEnc: Buffer | null;
}

export interface IntegrationUsage {
  /**
   * One to three lines: which entry tool to reach for plus one cardinal rule. Omitted where the
   * provider has nothing specific to say, which renders the generic line.
   *
   * Keep it SHORT. A rich per-service playbook does not belong in an always-injected preamble: it
   * taxes every job on every project that has the integration connected. `guideSlug` is the forward
   * pointer to that detail, fetched on demand.
   */
  hint?: string;
  /** Capability-guide slug carrying the full playbook, fetched on demand. */
  guideSlug?: string;
  /**
   * An extra indented line under the provider's bullet, built from the binding's effective config.
   *
   * Sentry is the only user today — it lists the labelled targets an agent picks between, because
   * the MCP server gets only host + token and the org/project slug is passed per call. This exists
   * so that stays in `integrations/sentry/` rather than as an `if (provider === 'sentry')` in the
   * prompt renderer, which is what it was until ISS-1071.
   */
  renderExtra?: (config: Record<string, unknown>) => string | null;
}

/** What an adapter DOES. Absent on a provider that integrates nothing (`agent`). */
export interface IntegrationAdapterMethods<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * The signing secret this provider will actually use for inbound deliveries, when it is the
   * provider — not Forge — that generated it.
   *
   * GitHub signs every delivery with the secret created with the App, so a binding that mints its
   * own fails EVERY signature check while the hub renders it configured: no delivery row, no error
   * anyone sees. Absent = Forge mints one, which is the normal case.
   */
  inboundSecret?(connection: IntegrationConnectionLike): string | null;
  /**
   * Called after this provider's CONNECTION is created or changed, for a provider holding a live
   * process that must be rebuilt against the new credential.
   *
   * Rocket.Chat is the only one: it keeps a realtime socket per connection. Declared here so the
   * generic route helper does not carry `if (provider !== 'rocketchat') return`, which is a line
   * that stays correct for rocketchat and silently does nothing for the next provider that needs it.
   */
  onConnectionChanged?(connectionId: string): void;
  /**
   * What this provider does once a binding of it is created on a project, and what the response
   * should carry about it.
   *
   * GitHub is the only one: binding a repository syncs `projects.repoPath`, and the caller is told
   * whether that changed. Declared so the generic bind door does not carry `provider === 'github'`,
   * which is a branch that keeps working for github and quietly does nothing for anyone else.
   */
  onBindingCreated?(args: {
    projectId: string;
    role: string;
    config: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  healthcheck(ctx: AdapterContext<TConfig, TSecrets>): Promise<HealthCheckResult>;
  dispatchOutbound?(
    ctx: AdapterContext<TConfig, TSecrets>,
    input: OutboundDispatchInput,
  ): Promise<OutboundDispatchResult>;
  handleInbound(
    ctx: AdapterContext<TConfig, TSecrets>,
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult>;
}

/**
 * An adapter that implements core's outbound call.
 *
 * What `canDispatch: true` commits a provider to, expressed so the compiler holds it at the one
 * place it is written rather than at every call site: a caller holding a `DispatchingAdapterMethods`
 * calls `dispatchOutbound` without a guard, and a caller holding a bare `IntegrationAdapterMethods`
 * is made to ask `registry.ts:dispatchThrough` instead.
 */
export type DispatchingAdapterMethods<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> = IntegrationAdapterMethods<TConfig, TSecrets> &
  Required<Pick<IntegrationAdapterMethods<TConfig, TSecrets>, 'dispatchOutbound'>>;

/**
 * ONE object per provider, and the only place a provider is described. Every generic path resolves
 * what it needs from here through `registry.ts`; nothing outside `integrations/<provider>/`, the
 * registry, the database schema and the contracts enums names a provider.
 */
export interface IntegrationDeclaration<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly provider: IntegrationProvider;
  readonly capabilities: IntegrationCapabilities;
  readonly schemas: IntegrationSchemas;
  /** Null where the provider has no agent-facing usage to advertise. */
  readonly usage: IntegrationUsage | null;
  readonly presentation: IntegrationPresentation | null;
  readonly releaseStep?: (namedChannels: string) => string;
  /** Absent exactly where nothing is integrated. */
  readonly adapter?: IntegrationAdapterMethods<TConfig, TSecrets>;
}

/** The declaration as an author writes it: `agentPath` is the one field that may be left out. */
export type IntegrationDeclarationInput<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> = Omit<IntegrationDeclaration<TConfig, TSecrets>, 'capabilities'> & {
  readonly capabilities: Omit<IntegrationCapabilities, 'agentPath'> & {
    readonly agentPath?: AgentPath;
  };
};

/**
 * Build a declaration, filling in the safer agent path for a provider that does not name one.
 *
 * This is a default in a CONSTRUCTOR, which is a different thing from the reader-side fallback it
 * replaced. `capabilitiesFor` applied an all-false default at every call site, so an adapter that
 * declared nothing looked inert everywhere and nowhere recorded that it had not answered. Here the
 * answer is recorded once, on the object, and every reader sees a field that is always present.
 */
export function declareIntegration<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
>(
  input: IntegrationDeclarationInput<TConfig, TSecrets>,
): IntegrationDeclaration<TConfig, TSecrets> {
  return {
    ...input,
    capabilities: {
      ...input.capabilities,
      agentPath: input.capabilities.agentPath ?? CORE_MEDIATED_BY_DEFAULT,
    },
  };
}
