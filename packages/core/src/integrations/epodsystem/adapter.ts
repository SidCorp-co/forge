import { logger } from '../../observability/logger.js';
import {
  declareIntegration,
  findConnectionById,
  type HealthCheckResult,
  type HealthStatus,
  type IntegrationAdapterMethods,
  isPreviousCredentialValid,
  updateConnection,
} from '../index.js';
import { epodsystemGraphqlBase } from './endpoints.js';
import { buildEpodsystemMcpEntry } from './resolver.js';
import {
  EPODSYSTEM_BINDING_CONFIG_KEYS,
  epodsystemConfigBase,
  epodsystemSecretsSchema,
} from './schemas.js';
import { epodsystemStorefrontTarget } from './target.js';
import type {
  ApiKeyContextResponse,
  ApiKeyStore,
  EpodsystemConfig,
  EpodsystemSecrets,
  StoreContextResponse,
} from './types.js';

const CONTEXT_TIMEOUT_MS = 15_000;

// Validates the key + resolves org/scopes/store. NEVER selects or echoes the
// key. `apiKeyContext` exposes org + scopes + a `stores` list (snake_case);
// ISS-387 is one-store-per-project, so we read `stores[0]`.
const API_KEY_CONTEXT_QUERY =
  'query ForgeApiKeyContext { apiKeyContext { organization_id scopes stores { id slug name commerce_enabled active_theme_id } } }';

const STORE_CONTEXT_QUERY =
  'query ForgeStoreContext($sid: ID!) { storeThemes(store_id: $sid) { id name role is_active } storeDomains(store_id: $sid) { domain is_primary } }';

const notSupported = (op: string): never => {
  // Epodsystem is MCP-injection-only; no webhook/dispatch surface exists.
  throw new Error(`epodsystem: ${op} is not supported (MCP-injection-only provider)`);
};

/** POST a GraphQL document with the bearer key under a shared timeout. */
async function gqlPost(
  url: string,
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: controller.signal,
    });
    const json = res.ok ? await res.json() : null;
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// One probe with a given key. Both an HTTP 401/403 and a 200 + GraphQL `errors[]` (the platform's
// resolver-layer auth rejection) read as `unauthorized`, so the rotation-window fallback covers both
// shapes (ISS-405).
type ProbeResult =
  | { kind: 'ok'; body: ApiKeyContextResponse }
  | { kind: 'unauthorized'; status: number }
  | { kind: 'http-error'; status: number };

async function probeApiKeyContext(url: string, key: string): Promise<ProbeResult> {
  const probe = await gqlPost(url, key, API_KEY_CONTEXT_QUERY);
  if (!probe.ok) {
    if (probe.status === 401 || probe.status === 403) {
      return { kind: 'unauthorized', status: probe.status };
    }
    return { kind: 'http-error', status: probe.status };
  }
  const body = probe.json as ApiKeyContextResponse;
  if (body.errors && body.errors.length > 0) return { kind: 'unauthorized', status: 200 };
  return { kind: 'ok', body };
}

/** Probe with the primary key, then once with a previous key still inside its rotation window. */
async function probeWithRotation(
  url: string,
  secrets: EpodsystemSecrets,
  apiKey: string,
): Promise<{ result: ProbeResult; activeKey: string }> {
  const result = await probeApiKeyContext(url, apiKey);
  if (
    result.kind !== 'unauthorized' ||
    !secrets.previousApiKey ||
    !isPreviousCredentialValid(secrets)
  ) {
    return { result, activeKey: apiKey };
  }
  const retry = await probeApiKeyContext(url, secrets.previousApiKey);
  return { result: retry, activeKey: retry.kind === 'ok' ? secrets.previousApiKey : apiKey };
}

async function markHealth(
  connectionId: string,
  status: HealthStatus,
  config?: Record<string, unknown>,
) {
  await updateConnection(connectionId, {
    ...(config ? { config } : {}),
    lastHealthStatus: status,
    lastHealthAt: new Date(),
  });
}

/** A key still rejected after the previous-key retry must be re-entered (ISS-409); any other HTTP error stays an error. */
async function rejected(
  connectionId: string,
  result: Exclude<ProbeResult, { kind: 'ok' }>,
): Promise<HealthCheckResult> {
  if (result.kind === 'http-error') {
    await markHealth(connectionId, 'error');
    return {
      status: 'error',
      message: `Epodsystem API error (HTTP ${result.status})`,
      diagnostics: { httpStatus: result.status },
    };
  }
  await markHealth(connectionId, 'needs_reauth');
  return {
    status: 'needs_reauth',
    message: 'invalid Epodsystem API key',
    ...(result.status === 200 ? {} : { diagnostics: { httpStatus: result.status } }),
  };
}

/** The store's active theme name and primary domain. Non-fatal: a failure leaves both null. */
async function enrichStore(
  url: string,
  key: string,
  store: ApiKeyStore,
  log: Record<string, unknown>,
): Promise<{ themeName: string | null; domain: string | null }> {
  try {
    const enrich = await gqlPost(url, key, STORE_CONTEXT_QUERY, { sid: String(store.id) });
    if (!enrich.ok) return { themeName: null, domain: null };
    const ed = (enrich.json as StoreContextResponse).data;
    const themes = ed?.storeThemes ?? [];
    const active =
      themes.find((t) => String(t.id) === String(store.active_theme_id)) ??
      themes.find((t) => t.role === 'main') ??
      null;
    const domains = ed?.storeDomains ?? [];
    return {
      themeName: active?.name ?? null,
      domain: (domains.find((d) => d.is_primary) ?? domains[0])?.domain ?? null,
    };
  } catch (err) {
    logger.warn(
      { ...log, err: err instanceof Error ? err.message : 'unknown' },
      'epodsystem: healthcheck enrichment failed (non-fatal)',
    );
    return { themeName: null, domain: null };
  }
}

/** Resolve org, scopes and the one store (ISS-387) into the connection config and the diagnostics. */
async function settleResolved(
  ctx: { connectionId: string; bindingId?: string | null },
  url: string,
  activeKey: string,
  body: ApiKeyContextResponse,
): Promise<HealthCheckResult> {
  const apiCtx = body.data?.apiKeyContext;
  // A valid key with no store yet leaves `store` undefined: key valid, identity unresolved.
  const store = apiCtx?.stores?.[0];
  const { themeName, domain } =
    store?.id != null
      ? await enrichStore(url, activeKey, store, {
          connectionId: ctx.connectionId,
          bindingId: ctx.bindingId,
        })
      : { themeName: null, domain: null };
  // Only non-secret store identity — never the key.
  const diagnostics = {
    orgId: apiCtx?.organization_id ?? null,
    scopes: Array.isArray(apiCtx?.scopes) ? apiCtx.scopes : null,
    storeId: store?.id != null ? String(store.id) : null,
    storeSlug: store?.slug ?? null,
    storeName: store?.name ?? null,
    themeId: store?.active_theme_id != null ? String(store.active_theme_id) : null,
    themeName,
    commerceEnabled: store?.commerce_enabled ?? null,
    domain,
  };
  const connection = await findConnectionById(ctx.connectionId);
  const resolved: Record<string, unknown> = {
    ...((connection?.config ?? {}) as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(diagnostics)) if (value != null) resolved[key] = value;
  await markHealth(ctx.connectionId, 'ok', resolved);
  return {
    status: 'ok',
    message: store?.name ? `Connected to ${store.name}` : 'Epodsystem API key is valid',
    diagnostics,
  };
}

const epodsystemAdapterMethods: IntegrationAdapterMethods<EpodsystemConfig, EpodsystemSecrets> = {
  async healthcheck(ctx): Promise<HealthCheckResult> {
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      await markHealth(ctx.connectionId, 'error');
      return { status: 'error', message: 'no Epodsystem API key configured' };
    }
    // The endpoint is fixed platform config, not per store: the crmk_ key resolves the org and store.
    const url = epodsystemGraphqlBase();
    try {
      const { result, activeKey } = await probeWithRotation(url, ctx.secrets, apiKey);
      if (result.kind !== 'ok') return await rejected(ctx.connectionId, result);
      return await settleResolved(ctx, url, activeKey, result.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await markHealth(ctx.connectionId, 'error');
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
        'epodsystem: healthcheck failed',
      );
      return { status: 'error', message };
    }
  },

  async handleInbound() {
    return notSupported('handleInbound');
  },
};

/**
 * Epodsystem's declaration. `direct-mcp`: the `crmk_` key is rendered into the runner's MCP config.
 *
 * `tools` is empty although core answers `forge_storefront_target` from the same binding, and that
 * is deliberate — the tool REPORTS the grant rather than being gated by it. Gating it would close a
 * read of the store's own non-secret context that is open today, and the grant is binary, so there
 * is no way to close the credential half and leave the context half open.
 */
export const epodsystemIntegration = declareIntegration<EpodsystemConfig, EpodsystemSecrets>({
  provider: 'epodsystem',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    // A storefront IS somewhere Forge deploys to: its preview is the draft theme and its live is
    // the published one, which is why three fleet storefronts carry one binding on both stages.
    canDeploy: true,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: true,
    structuredRollback: false,
    agentPath: {
      kind: 'direct-mcp',
      tools: [],
      serverName: 'epodsystem',
      previewSecrets: { apiKey: '[redacted]' },
      justification:
        'The storefront shop tools are the Epodsystem MCP server itself, authenticated by the store key. Forge has no API of its own in front of the theme and product surface, so the key reaches the runner or the shop skill has nothing to call.',
      buildEntry: (config, secrets) => {
        const apiKey = secrets.apiKey;
        if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
        return buildEpodsystemMcpEntry(config as EpodsystemConfig, apiKey);
      },
    },
  },
  schemas: {
    connectionConfig: epodsystemConfigBase,
    connectionPatchConfig: epodsystemConfigBase.partial(),
    bindingConfig: epodsystemConfigBase,
    patchConfig: epodsystemConfigBase.partial(),
    secrets: epodsystemSecretsSchema,
    patchSecrets: epodsystemSecretsSchema.partial(),
    primaryCredentialField: 'apiKey',
    previousCredentialField: 'previousApiKey',
    independentSecretFields: [],
    bindingConfigKeys: EPODSYSTEM_BINDING_CONFIG_KEYS,
  },
  usage: {
    hint: 'Read store + theme context via `forge_storefront_target` and customize the storefront via the `mcp__epodsystem__*` shop tools. Always build on the DRAFT theme; publishing promotes draft to main.',
  },
  presentation: {
    label: 'Epodsystem',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: 'never test-connected',
    cardMeta: (config) => {
      const cfg = config as { storeSlug?: string; storeName?: string };
      return { storeSlug: cfg.storeSlug ?? null, storeName: cfg.storeName ?? null };
    },
  },
  adapter: epodsystemAdapterMethods,
  storefrontTarget: epodsystemStorefrontTarget,
});
