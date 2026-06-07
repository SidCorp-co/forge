/**
 * ISS-387 — Epodsystem integration adapter.
 *
 * Like Postman, Epodsystem is an MCP-injection-only provider: all store/theme
 * mutation is driven by the official Epodsystem MCP server injected into the
 * runner (see `resolver.ts`). Core's only direct calls are the test-connection
 * GraphQL probes, which validate the `crmk_` key and surface non-secret store
 * identity back to the config UI. No outbound/inbound delivery surface exists.
 *
 * Probe 1 (`apiKeyContext`) validates the key + resolves org/scopes/store.
 * Probe 2 (best-effort: `storeThemes` + `storeDomains`) enriches the display
 * with the live theme NAME and the real primary DOMAIN — data apiKeyContext
 * itself does not carry. A failure of probe 2 never fails the connection.
 */

import { logger } from '../../logger.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { updateConnection } from '../store.js';
import type { HealthCheckResult, IntegrationAdapter } from '../types.js';
import { epodsystemGraphqlBase } from './endpoints.js';
import type {
  ApiKeyContextResponse,
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

// Enrichment (best-effort): the live theme NAME + the real primary domain.
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

export const epodsystemAdapter: IntegrationAdapter<EpodsystemConfig, EpodsystemSecrets> = {
  provider: 'epodsystem',
  // MCP-injection archetype: injects mcpServers.epodsystem into the runner; core
  // never dispatches or receives webhooks, so no env split / delivery log.
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    injectsMcp: true,
    hasEnvironments: false,
    prodConfirmGate: false,
    hasDeliveryLog: false,
  },

  async healthcheck(ctx): Promise<HealthCheckResult> {
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Epodsystem API key configured' };
    }

    // The endpoint is fixed platform config (EPODSYSTEM_ENDPOINT env, default
    // the prod admin host) — not per-store, not user-supplied. The crmk_ key
    // resolves the org/store on its own.
    const url = epodsystemGraphqlBase();
    try {
      const probe = await gqlPost(url, apiKey, API_KEY_CONTEXT_QUERY);
      if (!probe.ok) {
        await updateConnection(ctx.connectionId, {
          lastHealthStatus: 'error',
          lastHealthAt: new Date(),
        });
        const reason =
          probe.status === 401 || probe.status === 403
            ? 'invalid Epodsystem API key'
            : `Epodsystem API error (HTTP ${probe.status})`;
        return { status: 'error', message: reason, diagnostics: { httpStatus: probe.status } };
      }

      const body = probe.json as ApiKeyContextResponse;
      // A 200 with a GraphQL error array (auth rejected at the resolver layer)
      // is still a failure — surface it without leaking the key.
      if (body.errors && body.errors.length > 0) {
        await updateConnection(ctx.connectionId, {
          lastHealthStatus: 'error',
          lastHealthAt: new Date(),
        });
        return { status: 'error', message: 'invalid Epodsystem API key' };
      }

      const apiCtx = body.data?.apiKeyContext;
      // One-store-per-project (ISS-387): take the first store. A valid key with
      // no store yet leaves `store` undefined → key-valid, identity unresolved.
      const store = apiCtx?.stores?.[0];
      const orgId = apiCtx?.organization_id ?? null;
      const scopes = Array.isArray(apiCtx?.scopes) ? apiCtx.scopes : null;

      // Best-effort enrichment: resolve the live theme NAME + the real primary
      // domain. apiKeyContext gives only the theme id and no domain. A failure
      // here must NOT fail the connection — we still have a valid key.
      let themeName: string | null = null;
      let domain: string | null = null;
      if (store?.id != null) {
        try {
          const enrich = await gqlPost(url, apiKey, STORE_CONTEXT_QUERY, { sid: String(store.id) });
          if (enrich.ok) {
            const ed = (enrich.json as StoreContextResponse).data;
            const themes = ed?.storeThemes ?? [];
            const active =
              themes.find((t) => String(t.id) === String(store.active_theme_id)) ??
              themes.find((t) => t.role === 'main') ??
              null;
            themeName = active?.name ?? null;
            const domains = ed?.storeDomains ?? [];
            domain = (domains.find((d) => d.is_primary) ?? domains[0])?.domain ?? null;
          }
        } catch (err) {
          // Enrichment is non-fatal; log without the key.
          logger.warn(
            {
              connectionId: ctx.connectionId, bindingId: ctx.bindingId,
              err: err instanceof Error ? err.message : 'unknown',
            },
            'epodsystem: healthcheck enrichment failed (non-fatal)',
          );
        }
      }

      // Persist the resolved store identity into config (non-secret) so the
      // settings badge + Theme panel and `forge_storefront_target` show the real
      // store/theme without re-running the healthcheck. Only overwrite a field
      // when actually resolved, so a partial response never wipes prior values.
      // `draftThemeId` is build-time (created by customize_theme), not here.
      // The crmk_ key is NEVER written here.
      const resolved: Record<string, unknown> = { ...(ctx.config ?? {}) };
      if (orgId != null) resolved.orgId = orgId;
      if (scopes != null) resolved.scopes = scopes;
      if (store?.slug != null) resolved.storeSlug = store.slug;
      if (store?.name != null) resolved.storeName = store.name;
      if (store?.id != null) resolved.storeId = String(store.id);
      if (store?.active_theme_id != null) resolved.themeId = String(store.active_theme_id);
      if (themeName != null) resolved.themeName = themeName;
      if (store?.commerce_enabled != null) resolved.commerceEnabled = store.commerce_enabled;
      if (domain != null) resolved.domain = domain;
      await updateConnection(ctx.connectionId, {
        config: resolved,
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: store?.name ? `Connected to ${store.name}` : 'Epodsystem API key is valid',
        // Only non-secret store identity — never the key.
        diagnostics: {
          orgId,
          scopes,
          storeId: store?.id != null ? String(store.id) : null,
          storeSlug: store?.slug ?? null,
          storeName: store?.name ?? null,
          themeId: store?.active_theme_id != null ? String(store.active_theme_id) : null,
          themeName,
          commerceEnabled: store?.commerce_enabled ?? null,
          domain,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
        'epodsystem: healthcheck failed',
      );
      return { status: 'error', message };
    }
  },

  async dispatchOutbound() {
    return notSupported('dispatchOutbound');
  },

  async handleInbound() {
    return notSupported('handleInbound');
  },
};

export function registerEpodsystemAdapter(): void {
  if (getAdapter('epodsystem')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(epodsystemAdapter as any);
}
