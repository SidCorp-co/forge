import { logger } from '../../logger.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { findConnectionById, updateConnection } from '../store.js';
import {
  declareIntegration,
  type HealthCheckResult,
  type HealthStatus,
  type IntegrationAdapterMethods,
} from '../types.js';
import { type AutoflowGqlResult, autoflowGql } from './client.js';
import { autoflowBaseUrl, autoflowGraphqlUrl, autoflowMcpUrl } from './endpoints.js';
import {
  AUTOFLOW_INJECTION_MIN_LIFETIME_MS,
  AUTOFLOW_REFRESH_MARGIN_MS,
  type AutoflowFreshToken,
  ensureFreshAutoflowToken,
  reauthDetail,
} from './refresh.js';
import {
  AUTOFLOW_BINDING_CONFIG_KEYS,
  AUTOFLOW_BINDING_ONLY_CONFIG_KEYS,
  AUTOFLOW_INDEPENDENT_SECRET_FIELDS,
  autoflowBindingConfig,
  autoflowConnectionConfig,
  autoflowPatchSecretsSchema,
  autoflowSecretsSchema,
} from './schemas.js';
import { autoflowStorefrontTarget } from './target.js';
import type { AutoflowApiKeyContext, AutoflowConfig, AutoflowSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 15_000;

// `apiKeyContext` is the platform's self-describe query, exempt from every scope guard: it names
// the workspace and the ONE site an OAuth access token was minted for.
const CONTEXT_QUERY =
  'query ForgeAutoflowContext { apiKeyContext { organization_id stores { id slug name commerce_enabled active_theme_id } } }';

/** How to get a fresh token, said wherever a token is refused. */
function mintHint(config: AutoflowConfig): string {
  return `an access token (sat_…) lives 12 hours and is renewed from its refresh token (srt_…) while one is stored; without one, sign in at ${autoflowBaseUrl(config)} through an MCP client of ${autoflowMcpUrl(config)}, pick the workspace and the site${config.shop ? ` "${config.shop}"` : ''}, and store the new token`;
}

async function settle(
  connectionId: string,
  status: HealthStatus,
  result: HealthCheckResult,
  config?: Record<string, unknown>,
): Promise<HealthCheckResult> {
  await updateConnection(connectionId, {
    ...(config ? { config } : {}),
    lastHealthStatus: status,
    lastHealthDetail: status === 'ok' ? null : (result.message ?? null),
    lastHealthAt: new Date(),
  });
  return result;
}

const autoflowAdapterMethods: IntegrationAdapterMethods<AutoflowConfig, AutoflowSecrets> = {
  async healthcheck(ctx): Promise<HealthCheckResult> {
    let token = ctx.secrets?.accessToken;
    if (!token) {
      return settle(ctx.connectionId, 'error', {
        status: 'error',
        message: 'no Autoflow access token configured',
      });
    }
    const url = autoflowGraphqlUrl(ctx.config);
    const refused = (fresh: Extract<AutoflowFreshToken, { kind: 'needs_reauth' }>) =>
      settle(ctx.connectionId, 'needs_reauth', {
        status: 'needs_reauth',
        message: fresh.reason.startsWith('refresh_refused')
          ? reauthDetail(fresh.reason, autoflowBaseUrl(ctx.config))
          : `Autoflow access token expired and no refresh token is stored (${fresh.reason}); ${mintHint(ctx.config)}`,
        diagnostics: { refresh: fresh.reason },
      });
    try {
      const fresh = await ensureFreshAutoflowToken({
        connectionId: ctx.connectionId,
        config: ctx.config,
        minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
      });
      if (fresh.kind === 'needs_reauth') return refused(fresh);
      let current: AutoflowSecrets = fresh.secrets ?? ctx.secrets;
      token = current.accessToken;
      let probe: AutoflowGqlResult = await autoflowGql(url, token, CONTEXT_QUERY, PROBE_TIMEOUT_MS);
      if (probe.kind === 'unauthorized') {
        // A token refused before its recorded expiry (revoked, or the clock lied): refresh once.
        const retry = await ensureFreshAutoflowToken({
          connectionId: ctx.connectionId,
          config: ctx.config,
          minLifetimeMs: AUTOFLOW_REFRESH_MARGIN_MS,
          refusedToken: token,
        });
        if (retry.kind === 'needs_reauth' && retry.reason.startsWith('refresh_refused')) {
          return refused(retry);
        }
        if (retry.kind === 'ok' && retry.secrets.accessToken !== token) {
          current = retry.secrets;
          token = current.accessToken;
          probe = await autoflowGql(url, token, CONTEXT_QUERY, PROBE_TIMEOUT_MS);
        }
      }
      if (
        probe.kind === 'unauthorized' &&
        current.previousAccessToken &&
        isPreviousCredentialValid(current)
      ) {
        probe = await autoflowGql(
          url,
          current.previousAccessToken,
          CONTEXT_QUERY,
          PROBE_TIMEOUT_MS,
        );
      }
      if (probe.kind === 'unauthorized') {
        return settle(ctx.connectionId, 'needs_reauth', {
          status: 'needs_reauth',
          message: `Autoflow refused the access token (${probe.message}); ${mintHint(ctx.config)}`,
          diagnostics: { httpStatus: probe.status },
        });
      }
      if (probe.kind === 'http-error') {
        return settle(ctx.connectionId, 'error', {
          status: 'error',
          message: `Autoflow API error (HTTP ${probe.status}) at ${url}`,
          diagnostics: { httpStatus: probe.status },
        });
      }
      if (probe.kind === 'graphql-error') {
        return settle(ctx.connectionId, 'error', {
          status: 'error',
          message: `Autoflow answered apiKeyContext with an error: ${probe.message}`,
        });
      }

      const apiCtx = probe.data.apiKeyContext as AutoflowApiKeyContext | null | undefined;
      const stores = apiCtx?.stores ?? [];
      // An OAuth access token is pinned to ONE site; anything else is not guessed at.
      if (stores.length !== 1 || !stores[0]) {
        return settle(ctx.connectionId, 'needs_reauth', {
          status: 'needs_reauth',
          message: `the token resolves to ${stores.length} sites, and an Autoflow access token is minted for exactly one; ${mintHint(ctx.config)}`,
        });
      }
      const store = stores[0];
      if (ctx.config.shop && store.slug !== ctx.config.shop) {
        return settle(ctx.connectionId, 'needs_reauth', {
          status: 'needs_reauth',
          message: `the token was minted for site "${store.slug ?? '(no slug)'}", and this binding names shop "${ctx.config.shop}"; ${mintHint(ctx.config)}`,
          diagnostics: { tokenSite: store.slug ?? null, bindingShop: ctx.config.shop },
        });
      }

      const connection = await findConnectionById(ctx.connectionId);
      const resolved: Record<string, unknown> = {
        ...((connection?.config ?? {}) as Record<string, unknown>),
      };
      if (apiCtx?.organization_id) resolved.orgId = apiCtx.organization_id;
      if (store.id != null) resolved.storeId = String(store.id);
      if (store.slug) resolved.storeSlug = store.slug;
      if (store.name) resolved.storeName = store.name;
      if (store.active_theme_id != null) resolved.themeId = String(store.active_theme_id);
      if (store.commerce_enabled != null) resolved.commerceEnabled = store.commerce_enabled;
      return settle(
        ctx.connectionId,
        'ok',
        {
          status: 'ok',
          message: store.name ? `Connected to ${store.name}` : 'Autoflow access token is valid',
          diagnostics: {
            orgId: apiCtx?.organization_id ?? null,
            storeId: store.id != null ? String(store.id) : null,
            storeSlug: store.slug ?? null,
            storeName: store.name ?? null,
            themeId: store.active_theme_id != null ? String(store.active_theme_id) : null,
          },
        },
        resolved,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
        'autoflow: healthcheck failed',
      );
      return settle(ctx.connectionId, 'error', { status: 'error', message });
    }
  },

  async handleInbound() {
    throw new Error(
      'autoflow: handleInbound is not supported — Autoflow sends Forge no webhooks; the agent reaches it through the shop MCP only',
    );
  },
};

/**
 * Autoflow ("Sidcorp Auto"): a project that runs ON the platform — a site plus its Backend Builder
 * flows — with no git repository. `direct-mcp`: the site's OAuth access token is rendered into the
 * runner's MCP config for the shop MCP server, and core only reports the target.
 */
export const autoflowIntegration = declareIntegration<AutoflowConfig, AutoflowSecrets>({
  provider: 'autoflow',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    // Every write lands on a draft (a workflow's draft graph, the theme's draft surface) and
    // `publish_backend_workflow` / `publish_draft_theme` promote it — a deploy the agent performs.
    canDeploy: true,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: true,
    structuredRollback: false,
    agentPath: {
      kind: 'direct-mcp',
      tools: [],
      serverName: 'autoflow',
      previewSecrets: { accessToken: '[redacted]' },
      justification:
        'The site and its Backend Builder flows are built through the Autoflow shop MCP server itself, opened only by the site-bound OAuth access token. Forge has no API of its own in front of that surface, so the token reaches the runner or the build has nothing to call.',
      // A run outlives a probe: it is handed a token good for hours, refreshed first where due.
      freshSecrets: async ({ connectionId, config }) => {
        const fresh = await ensureFreshAutoflowToken({
          connectionId,
          config,
          minLifetimeMs: AUTOFLOW_INJECTION_MIN_LIFETIME_MS,
        });
        return fresh.kind === 'needs_reauth' ? null : fresh.secrets;
      },
      buildEntry: (config, secrets) => {
        const token = secrets.accessToken;
        if (typeof token !== 'string' || token.length === 0) return null;
        return {
          type: 'http',
          url: autoflowMcpUrl(config),
          headers: { Authorization: `Bearer ${token}` },
          enabled: true,
        };
      },
    },
  },
  schemas: {
    connectionConfig: autoflowConnectionConfig,
    connectionPatchConfig: autoflowConnectionConfig.partial(),
    bindingConfig: autoflowBindingConfig,
    patchConfig: autoflowBindingConfig.partial(),
    secrets: autoflowSecretsSchema,
    patchSecrets: autoflowPatchSecretsSchema,
    primaryCredentialField: 'accessToken',
    previousCredentialField: 'previousAccessToken',
    independentSecretFields: AUTOFLOW_INDEPENDENT_SECRET_FIELDS,
    bindingConfigKeys: AUTOFLOW_BINDING_CONFIG_KEYS,
    bindingOnlyConfigKeys: AUTOFLOW_BINDING_ONLY_CONFIG_KEYS,
  },
  usage: {
    hint: 'Read the site + its flows via `forge_storefront_target`, build through the `mcp__autoflow__*` shop tools. Writes land on drafts; `publish_backend_workflow` / `publish_draft_theme` go live, `revert_backend_workflow` rolls back.',
  },
  presentation: {
    label: 'Autoflow',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: 'never test-connected',
    cardMeta: (config) => {
      const cfg = config as AutoflowConfig;
      return { shop: cfg.shop ?? null, storeName: cfg.storeName ?? null };
    },
  },
  adapter: autoflowAdapterMethods,
  storefrontTarget: autoflowStorefrontTarget,
});
