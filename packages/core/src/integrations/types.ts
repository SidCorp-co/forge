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
  // cm:why `agent` carries a DECLARATION and no adapter methods — nothing is integrated. It is a
  // release CHANNEL declaration (which box may ship, how to prove it shipped, how to undo it), and
  // the deploy itself is the project's own script run by the release session. `getAdapter` answers
  // `undefined` for it and every caller already guards that, so the absence is a supported shape.
  // What ISS-1071 changed is that the absence of METHODS no longer means absence from the registry:
  // its schemas and its `agentPath: none` are declared there like every other provider's.
  | 'agent';

/**
 * Runtime form of {@link IntegrationProvider} — for validating caller-supplied strings.
 *
 * This list and the registry are two statements of one vocabulary, and `registry.test.ts` refuses
 * them when they disagree: the union is what the compiler checks, the registry is what the code
 * asks at run time, and a provider present in one and not the other is a provider half of the
 * system does not know about.
 */
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

// cm:guard adding a provider to the union above without adding it here fails this line — keep both in lockstep rather than letting the runtime list silently lag the type
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
// cm:guard 401 and 403 are different verdicts and must never be collapsed into one — a 403 mapped to `needs_reauth` sends the operator to replace a credential that works, and re-entering it reproduces the state exactly (ISS-924)
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
 * How — if at all — an agent running this project's work can reach this provider, and at whose
 * risk. ISS-1071 replaced the boolean `injectsMcp` with this, because the two shapes it collapsed
 * carry different blast radii and must not share a word.
 *
 * - `none` — nothing an agent calls. The grant column on such a binding is inert and no screen
 *   offers it a control.
 * - `core-mediated` — core holds the credential and makes the call; the agent asks core through the
 *   named MCP tools. Forge is in the call path and can refuse, rate-limit and audit.
 * - `direct-mcp` — the credential is RENDERED INTO THE RUNNER'S MCP CONFIG and the agent calls the
 *   provider itself, with Forge outside the call path. `sentry` additionally executes an npm
 *   package on the runner with the token in its environment.
 *
 * `tools` is on both non-`none` arms because a provider can be both at once: epodsystem's `crmk_`
 * key reaches the runner AND core answers `forge_storefront_target` from the same binding. The
 * `kind` names the RISK; `tools` names the core-mediated surface the same grant gates.
 */
// cm:guard `justification` is required on `direct-mcp` and on no other arm, and it is the whole of
// how ISS-1071 rule 2 ("a new provider defaults to core-mediated; direct-mcp is for providers that
// offer no other route, and the registry records that intent") is kept honest. Deleting the field
// does not weaken a message — it removes the only place the decision to export a project's
// credential to a runner box is written down, and `check-integration-declarations.mjs` reads it.
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
      /**
       * A credential-SHAPED placeholder, carrying no secret, so the MCP preview can render this
       * entry's shape without decrypting anything.
       *
       * `buildEntry` refuses an absent credential by returning null, which is right for dispatch and
       * wrong for a preview: the preview knows a credential is stored (`secretsEnc !== null`) and is
       * forbidden from reading it, so with `{}` it got null back and reported no URL for a binding
       * that has one. Every value here must be visibly redacted — it is passed to a real builder and
       * must be impossible to mistake for a working credential if it ever escapes.
       */
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
export interface IntegrationUsage {
  /** One to three lines: which entry tool to reach for plus one cardinal rule. */
  hint: string;
  /** Capability-guide slug carrying the full playbook, fetched on demand. */
  guideSlug?: string;
}

/** What an adapter DOES. Absent on a provider that integrates nothing (`agent`). */
export interface IntegrationAdapterMethods<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSecrets extends Record<string, unknown> = Record<string, unknown>,
> {
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
  /** Null where the provider renders no status card of its own. */
  readonly presentation: IntegrationPresentation | null;
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
>(input: IntegrationDeclarationInput<TConfig, TSecrets>): IntegrationDeclaration<TConfig, TSecrets> {
  return {
    ...input,
    capabilities: {
      ...input.capabilities,
      agentPath: input.capabilities.agentPath ?? CORE_MEDIATED_BY_DEFAULT,
    },
  };
}
