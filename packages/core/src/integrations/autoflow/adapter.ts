import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import { logger } from '../../lib/logger.js';
import {
  type AdapterContext,
  declareIntegration,
  findConnectionById,
  type HealthCheckResult,
  type HealthStatus,
  healthOf,
  type IntegrationAdapterMethods,
  isPreviousCredentialValid,
  recordHealth,
  thrownSaid,
} from '../index.js';
import { type AutoflowGqlResult, autoflowGql } from './client.js';
import { autoflowStorefrontDrafts } from './draft.js';
import { autoflowBaseUrl, autoflowGraphqlUrl, autoflowMcpUrl } from './endpoints.js';
import { autoflowStorefrontPublished } from './published.js';
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

/** Where to store a fresh token, said wherever a token is refused. */
function signIn(config: AutoflowConfig): Said {
  const at = { base: autoflowBaseUrl(config), mcp: autoflowMcpUrl(config) };
  return config.shop
    ? say('integrations.health.autoflow.signInShop', { ...at, shop: config.shop })
    : say('integrations.health.autoflow.signIn', at);
}

/**
 * The token's own standing — present, fresh, refused, the one site it was minted for — is the
 * connection's, read alike by every binding of it. Whether that site is this binding's `shop` is the
 * binding's alone (ISS-983): `ok` is both, the token held and the shop is its site.
 */
async function settle(
  ctx: Pick<AdapterContext, 'connectionId' | 'bindingId'>,
  status: HealthStatus,
  result: HealthCheckResult,
  config?: Record<string, unknown>,
): Promise<HealthCheckResult> {
  await recordHealth(ctx, {
    connection: { status, detail: status === 'ok' ? null : (result.says?.message ?? null) },
    ...(status === 'ok' ? { binding: { status: 'ok' as const, detail: null } } : {}),
    ...(config ? { connectionConfig: config } : {}),
  });
  return result;
}

const autoflowAdapterMethods: IntegrationAdapterMethods<AutoflowConfig, AutoflowSecrets> = {
  healthReadsBinding: true,

  async healthcheck(ctx): Promise<HealthCheckResult> {
    let token = ctx.secrets?.accessToken;
    if (!token) {
      return settle(ctx, 'error', healthOf('error', say('integrations.health.autoflow.noToken')));
    }
    const url = autoflowGraphqlUrl(ctx.config);
    const refused = (fresh: Extract<AutoflowFreshToken, { kind: 'needs_reauth' }>) =>
      settle(
        ctx,
        'needs_reauth',
        healthOf(
          'needs_reauth',
          fresh.reason.startsWith('refresh_refused')
            ? reauthDetail(fresh.reason, autoflowBaseUrl(ctx.config))
            : say('integrations.health.autoflow.expired', {
                reason: fresh.reason,
                hint: signIn(ctx.config),
              }),
          { refresh: fresh.reason },
        ),
      );
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
        return settle(
          ctx,
          'needs_reauth',
          healthOf(
            'needs_reauth',
            say('integrations.health.autoflow.refused', {
              why: verbatim(probe.message),
              hint: signIn(ctx.config),
            }),
            { httpStatus: probe.status },
          ),
        );
      }
      if (probe.kind === 'http-error') {
        return settle(
          ctx,
          'error',
          healthOf(
            'error',
            say('integrations.health.autoflow.http', { status: String(probe.status), url }),
            { httpStatus: probe.status },
          ),
        );
      }
      if (probe.kind === 'graphql-error') {
        return settle(
          ctx,
          'error',
          healthOf(
            'error',
            say('integrations.health.autoflow.gqlError', { why: verbatim(probe.message) }),
          ),
        );
      }

      const apiCtx = probe.data.apiKeyContext as AutoflowApiKeyContext | null | undefined;
      const stores = apiCtx?.stores ?? [];
      // An OAuth access token is pinned to ONE site; anything else is not guessed at.
      if (stores.length !== 1 || !stores[0]) {
        return settle(
          ctx,
          'needs_reauth',
          healthOf(
            'needs_reauth',
            say('integrations.health.autoflow.sites', {
              n: stores.length,
              hint: signIn(ctx.config),
            }),
          ),
        );
      }
      const store = stores[0];
      if (ctx.config.shop && store.slug !== ctx.config.shop) {
        // the token holds, for its own site; that it is not this binding's shop is this binding's
        const otherSite = say('integrations.health.autoflow.otherSite', {
          site: store.slug ? verbatim(store.slug) : say('integrations.health.autoflow.noSlug'),
          shop: ctx.config.shop,
          hint: signIn(ctx.config),
        });
        await recordHealth(ctx, {
          connection: { status: 'ok', detail: null },
          binding: { status: 'needs_reauth', detail: otherSite },
        });
        return healthOf('needs_reauth', otherSite, {
          tokenSite: store.slug ?? null,
          bindingShop: ctx.config.shop,
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
        ctx,
        'ok',
        healthOf(
          'ok',
          store.name
            ? say('integrations.health.connectedTo', { name: store.name })
            : say('integrations.health.autoflow.valid'),
          {
            orgId: apiCtx?.organization_id ?? null,
            storeId: store.id != null ? String(store.id) : null,
            storeSlug: store.slug ?? null,
            storeName: store.name ?? null,
            themeId: store.active_theme_id != null ? String(store.active_theme_id) : null,
          },
        ),
        resolved,
      );
    } catch (err) {
      const said = thrownSaid(err, true);
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: sayEn(said) },
        'autoflow: healthcheck failed',
      );
      return settle(ctx, 'error', healthOf('error', said));
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
 * flows — with no git repository. `direct-mcp`: the run's MCP config names Forge's relay for the shop
 * MCP server, and core adds the site's OAuth access token to each relayed call (REQ-21 BC-2).
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
      routes: [],
      serverName: 'autoflow',
      previewSecrets: { accessToken: '[redacted]' },
      justification:
        'The site and its Backend Builder flows are built through the Autoflow shop MCP server itself, opened only by the site-bound OAuth access token. Forge has no API of its own in front of that surface, so Forge relays each MCP call of a run to it (/api/mcp-relay) and adds the token itself; the run holds only a relay ticket.',
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
    hint: 'Read the site + its flows at `GET /api/projects/:id/integrations/storefront/target`, build through the `mcp__autoflow__*` shop tools. Writes land on drafts; `publish_backend_workflow` / `publish_draft_theme` go live, `revert_backend_workflow` rolls back.',
  },
  presentation: {
    label: 'Autoflow',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverTested'),
    cardMeta: (config) => {
      const cfg = config as AutoflowConfig;
      return { shop: cfg.shop ?? null, storeName: cfg.storeName ?? null };
    },
  },
  adapter: autoflowAdapterMethods,
  storefrontTarget: autoflowStorefrontTarget,
  storefrontDrafts: autoflowStorefrontDrafts,
  storefrontPublished: autoflowStorefrontPublished,
});
