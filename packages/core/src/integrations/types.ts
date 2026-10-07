import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import type { ProjectPermission } from '@forge/contracts/permissions';
import type { z } from 'zod';
import type { Tx } from '../db/client.js';
import type { BindingRole } from '../db/schema.js';
import type { TargetedDeployAdapter } from './deploy/index.js';
import type { SourceHostFactory } from './source-host/index.js';

export type IntegrationProvider =
  | 'coolify'
  | 'epodsystem'
  | 'sentry'
  | 'rocketchat'
  | 'github'
  | 'gitlab'
  | 'agent'
  | 'autoflow';

export const INTEGRATION_PROVIDERS = [
  'coolify',
  'epodsystem',
  'sentry',
  'rocketchat',
  'github',
  'gitlab',
  'agent',
  'autoflow',
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
  /**
   * Called once a deploy's fan-out ends, thrown or not, with what each target became, before the
   * dispatch answers or throws. The caller owns what a deploy means to a run; the adapter only
   * reports it.
   */
  onDeployOutcome?: (outcome: DeployDispatchOutcome) => Promise<void>;
}

/** One deploy target's dispatch, as the deploy port reports it. */
export interface DeployTargetDispatch {
  deliveryId: string;
  targetLabel: string;
  /** The provider's id for the build it accepted; null where it refused. */
  deploymentUuid: string | null;
  status: 'pending' | 'failed';
  detail?: string;
}

export interface DeployDispatchOutcome {
  runId: string | null;
  bindingId: string;
  requestId?: string;
  targets: DeployTargetDispatch[];
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
  /**
   * Writes the delivery's facts on the transaction that settles its row `ok`: a fact that cannot be
   * written rolls the settle back, and the delivery stays `failed` and is applied again on redelivery.
   */
  emitFacts: (tx: Tx, facts: readonly InboundFact[]) => Promise<void>;
}

/** The facts a vendor delivery reports to Forge's own modules, written to the outbox by the door. */
type InboundFactType = 'source.pushed' | 'source.merged' | 'source.reviewed';
export type InboundFact = {
  [T in InboundFactType]: { type: T; payload: OutboxEventPayload<T> };
}[InboundFactType];

export interface InboundDispatchResult {
  deliveryId: string;
  actions: number;
  refusal?: string;
}

export type AgentPath =
  | { readonly kind: 'none' }
  | { readonly kind: 'core-mediated'; readonly tools: readonly string[] }
  | {
      /**
       * Core answers the tools, and holding `permission` on the project decides who may use them,
       * agent or person; the binding carries no agent access grant.
       */
      readonly kind: 'permission';
      readonly tools: readonly string[];
      readonly permission: ProjectPermission;
    }
  | {
      readonly kind: 'direct-mcp';
      readonly tools: readonly string[];
      /** Base MCP server name. A `multiBinding` provider suffixes it per label. */
      readonly serverName: string;
      /** Why this provider offers no core-mediated route. Read by the declaration checker. */
      readonly justification: string;
      readonly previewSecrets: Record<string, unknown>;
      /**
       * Runs BEFORE `buildEntry` at injection, for a provider whose stored credential expires: it
       * answers the secrets to render (refreshed and persisted where due), or null where the
       * connection can produce no usable credential and the entry is left out. Absent = the stored
       * secrets are rendered as they are.
       */
      freshSecrets?(input: {
        connectionId: string;
        config: Record<string, unknown>;
        secrets: Record<string, unknown>;
      }): Promise<Record<string, unknown> | null>;
      /** Renders the runner's `mcpServers` entry. Returns null when the credential is unusable. */
      buildEntry(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
      ): Record<string, unknown> | null;
    };

export type AgentPathKind = AgentPath['kind'];

/** The shape every provider that is not `direct-mcp` takes when it does not say otherwise. */
const CORE_MEDIATED_BY_DEFAULT: AgentPath = { kind: 'core-mediated', tools: [] };

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
   * True where a bound resource makes this provider call IN by itself, so a binding that has
   * recorded no inbound delivery is a broken pipe rather than a quiet period.
   *
   * GitHub calls on every push and pull request against a repository its App is installed on, so
   * zero-ever on a live binding means nothing is arriving and something is wrong. Sentry calls
   * only when an error happens, and a project with no errors has correctly received nothing —
   * demoting that binding would be the same lie pointing the other way. `canReceiveWebhook` is
   * therefore the wrong condition to read for this, and it is declared instead of inferred.
   *
   * Only meaningful where `canReceiveWebhook` is true.
   */
  inboundUnprompted: boolean;
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
   * `integration-door/webhook-inbound-routes.ts` — a file with no other reason to know a provider exists, and one
   * that would keep routing correctly for the providers it already listed while silently dropping a
   * new one on the floor. Only meaningful where `canReceiveWebhook` is true.
   */
  webhookHeader?: string;
  webhookSignatureHeader?: string;
  /**
   * How the signature header proves a delivery is the provider's. `hmac-sha256` (the default)
   * signs the body; `shared-token` carries the binding's secret itself, which is GitLab's scheme
   * (`X-Gitlab-Token`) and is compared in constant time.
   */
  webhookVerification?: 'hmac-sha256' | 'shared-token';
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
interface IntegrationSchemas {
  /** Owner-scoped connection create: the credential tier's config. */
  connectionConfig: z.ZodTypeAny;
  /**
   * The partial of `connectionConfig` a connection PATCH validates against, which is a schema of
   * its own rather than `connectionConfig.partial()` at the call site: zod refuses `.partial()` on
   * an object carrying refinements, so one provider's answer is its already-optional schema
   * unchanged. Declared per provider so a provider added later cannot skip the question (ISS-1275).
   *
   * Without it the PATCH read the CREATE schema, and a provider whose required keys live at the
   * BINDING tier — coolify's `targets` — could take no connection config patch at all.
   */
  connectionPatchConfig: z.ZodTypeAny;
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
  /** The subset no binding inherits from its connection: one stored there is never read. */
  bindingOnlyConfigKeys?: readonly string[];
}

/**
 * How this provider renders as a status card, or `null` where it has no card of its own.
 *
 * ISS-1071 moved this off `status-service.ts`, which carried six hand-written blocks differing only
 * in these four values — so adding a provider meant editing a file that had no other reason to know
 * one existed. `github` declares `null` because its card is built from the project's repository
 * rather than from a binding, and `agent` because a release channel is not an integration to show.
 */
interface IntegrationPresentation {
  /** Human label on the card. */
  label: string;
  /** Key every card by stage even where there is one binding, because the provider is stage-split
   *  by design. Others keep the bare key until a second binding appears, which keeps an existing
   *  drill-in's bookmark working. */
  alwaysEnvironmentKeyed: boolean;
  /** What the card says when the connection has never been health-checked. */
  neverCheckedDetail: string;
  /** Non-secret config fields this provider's card surfaces. Never a credential. */
  cardMeta?: (config: Record<string, unknown>) => Record<string, unknown>;
  /** What one binding points at, read where two of a role on one project share every other name. */
  bindingIdentity?: (config: Record<string, unknown>) => string | null;
  /**
   * The names the provider itself reports for what each binding points at (a Coolify application's
   * own name), asked live. A binding it cannot answer for is absent, and `bindingIdentity` names it.
   */
  reportedIdentities?: (
    bindings: readonly ReportedIdentityBinding[],
  ) => Promise<ReadonlyMap<string, string>>;
}

/** One binding as `reportedIdentities` asks about it: its id, its effective config, its connection. */
export interface ReportedIdentityBinding {
  id: string;
  config: Record<string, unknown>;
  connection: IntegrationConnectionLike & { id: string };
}

/** The short router hint and forward pointer injected into the preamble when this is reachable. */
/** The connection row shape a binding-target check reads — kept structural so `types.ts` imports no db. */
interface IntegrationConnectionLike {
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

/** A binding target the provider refused, at a path inside `target`. */
export interface BindingTargetRefusal {
  code:
    | 'COOLIFY_APPLICATION_UNKNOWN'
    | 'COOLIFY_UNREACHABLE'
    | 'SOURCE_HOST_MISMATCH'
    | 'SOURCE_REPOSITORY_LOCAL';
  path: string;
  detail: string;
}

export interface VerifyBindingTargetArgs {
  projectId: string;
  connection: IntegrationConnectionLike & { config: unknown };
  /** The binding-tier config the document encodes to. */
  config: Record<string, unknown>;
  /** What the row already holds on this same connection, which was verified when written. */
  held: Record<string, unknown> | null;
}

/** What `forge_storefront_target` hands a provider's `storefrontTarget`: the one binding it selected. */
export interface StorefrontTargetArgs {
  /** The connection the secrets belong to: a provider whose token expires refreshes it there. */
  connectionId: string;
  /** The binding's effective config: connection config overlaid with the binding's own. */
  config: Record<string, unknown>;
  /** Decrypts the connection's secrets on demand; a provider that reads nothing live never calls it. */
  readSecrets(): Record<string, unknown>;
}

export type StorefrontDraftReading =
  | { readonly kind: 'read'; readonly draftVersion: string; readonly workflowCode: string }
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

/** What an adapter DOES. Absent on a provider that integrates nothing (`agent`). */
export interface IntegrationAdapterMethods<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * The connection secret field holding the inbound signing secret, when it is the provider — not
   * Forge — that generated it (`inbound-secret.ts`). GitHub signs every delivery with the secret
   * created with the App, so a binding that minted its own would fail EVERY signature check.
   * Absent = Forge mints one, which is the normal case.
   */
  inboundSecretField?: string;
  /** Where a person pastes a rotated inbound secret, said once in the rotation's answer. */
  inboundSecretHome?: string;
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
   * GitHub is the only one: the caller is told whether the repository it bound is the one the
   * project document's `source.git.repository` declares. Declared so the generic bind door does not carry `provider === 'github'`,
   * which is a branch that keeps working for github and quietly does nothing for anyone else.
   */
  onBindingCreated?(args: {
    projectId: string;
    role: string;
    config: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  /**
   * Asks the provider, through the connection's own credential, whether the target a binding
   * document names exists. Coolify is the only one: a typed application uuid is otherwise stored
   * unverified and fails at the first deploy.
   */
  verifyBindingTarget?(args: VerifyBindingTargetArgs): Promise<BindingTargetRefusal[]>;
  healthcheck(ctx: AdapterContext<TConfig, TSecrets>): Promise<HealthCheckResult>;
  deploymentRecords?(
    ctx: AdapterContext<TConfig, TSecrets>,
    timeoutMs: number,
  ): TargetedDeployAdapter;
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
  /** Absent exactly where nothing is integrated. */
  readonly adapter?: IntegrationAdapterMethods<TConfig, TSecrets>;
  /**
   * The provider-specific half of `forge_storefront_target`'s answer for one selected binding.
   * Present exactly on the providers a project's `source.storefront` may name; the tool serves
   * every provider declaring it and names the rest when asked for one.
   */
  readonly storefrontTarget?: (args: StorefrontTargetArgs) => Promise<Record<string, unknown>>;
  /** The draft the provider holds now of each workflow named, read once for all of them. */
  readonly storefrontDrafts?: (
    args: StorefrontTargetArgs & { workflowIds: readonly string[] },
  ) => Promise<Map<string, StorefrontDraftReading>>;
  /** Present where a binding of this provider is the host a project's repository lives on. */
  readonly sourceHost?: SourceHostFactory;
  /** Present where this provider can mint a short-lived HTTPS git credential for a runner. */
  readonly gitCredential?: GitCredentialMint;
}

/** What `source-host/host-credential.ts` asks of a provider for one repository git is fetching. */
export interface GitCredentialMint {
  /** Whether this binding is complete enough to mint for at all — the provision flag reads it. */
  serves(config: Record<string, unknown>): boolean;
  /** Whether this binding reaches the repository git named by `host` and `path`. */
  reaches(config: Record<string, unknown>, host: string, path: string): boolean;
  /** The binding's repository as a person reads it, for a refusal or a log line. */
  repositoryOf(config: Record<string, unknown>): string;
  mint(args: {
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  }): Promise<{ username: string; password: string; expiresAt: string }>;
}

/** The declaration as an author writes it: `agentPath` is the one field that may be left out. */
type IntegrationDeclarationInput<
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
