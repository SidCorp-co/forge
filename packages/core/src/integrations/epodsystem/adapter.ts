/**
 * ISS-387 — Epodsystem integration adapter.
 *
 * Like Postman, Epodsystem is an MCP-injection-only provider: all store/theme
 * mutation is driven by the official Epodsystem MCP server injected into the
 * runner (see `resolver.ts`). Core makes only ONE direct call — the
 * test-connection GraphQL `apiKeyContext` query (mirrors postman `GET /me`),
 * which validates the `crmk_` key and surfaces non-secret store identity back
 * to the config UI. No outbound/inbound delivery surface exists.
 */

import { logger } from '../../logger.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { updateIntegration } from '../store.js';
import type { HealthCheckResult, IntegrationAdapter } from '../types.js';
import { epodsystemGraphqlBase } from './endpoints.js';
import type { ApiKeyContextResponse, EpodsystemConfig, EpodsystemSecrets } from './types.js';

const CONTEXT_TIMEOUT_MS = 15_000;

// The non-secret store identity query. NEVER selects or echoes the key.
const API_KEY_CONTEXT_QUERY =
  'query ForgeApiKeyContext { apiKeyContext { storeSlug storeName themeId draftThemeId commerceEnabled } }';

const notSupported = (op: string): never => {
  // Epodsystem is MCP-injection-only; no webhook/dispatch surface exists.
  throw new Error(`epodsystem: ${op} is not supported (MCP-injection-only provider)`);
};

export const epodsystemAdapter: IntegrationAdapter<EpodsystemConfig, EpodsystemSecrets> = {
  provider: 'epodsystem',

  async healthcheck(ctx): Promise<HealthCheckResult> {
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Epodsystem API key configured' };
    }

    const endpoint = ctx.config?.endpoint;
    if (!endpoint) {
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Epodsystem endpoint configured' };
    }

    const url = epodsystemGraphqlBase(endpoint);
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
        body: JSON.stringify({ query: API_KEY_CONTEXT_QUERY }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        await updateIntegration(ctx.integrationId, {
          lastHealthStatus: 'error',
          lastHealthAt: new Date(),
        });
        // 401/403 → bad key; surface a clear, key-free message.
        const reason =
          res.status === 401 || res.status === 403
            ? 'invalid Epodsystem API key'
            : `Epodsystem API error (HTTP ${res.status})`;
        return { status: 'error', message: reason, diagnostics: { httpStatus: res.status } };
      }

      const body = (await res.json()) as ApiKeyContextResponse;
      // A 200 with a GraphQL error array (e.g. auth rejected at the resolver
      // layer) is still a failure — surface it without leaking the key.
      if (body.errors && body.errors.length > 0) {
        await updateIntegration(ctx.integrationId, {
          lastHealthStatus: 'error',
          lastHealthAt: new Date(),
        });
        return { status: 'error', message: 'invalid Epodsystem API key' };
      }

      const sctx = body.data?.apiKeyContext ?? {};
      // Persist the resolved store identity back into config (non-secret) so the
      // settings badge + Theme panel and `forge_storefront_target` show the real
      // store/theme without re-running the healthcheck (AC#1). Only overwrite a
      // field when the backend actually returned it, so a partial response never
      // wipes previously-resolved values. The crmk_ key is NEVER written here.
      const resolved: Record<string, unknown> = { ...(ctx.config ?? {}) };
      if (sctx.storeSlug != null) resolved.storeSlug = sctx.storeSlug;
      if (sctx.storeName != null) resolved.storeName = sctx.storeName;
      if (sctx.themeId != null) resolved.themeId = sctx.themeId;
      if (sctx.draftThemeId != null) resolved.draftThemeId = sctx.draftThemeId;
      if (sctx.commerceEnabled != null) resolved.commerceEnabled = sctx.commerceEnabled;
      await updateIntegration(ctx.integrationId, {
        config: resolved,
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: sctx.storeName ? `Connected to ${sctx.storeName}` : 'Epodsystem API key is valid',
        // Only non-secret store identity — never the key.
        diagnostics: {
          storeSlug: sctx.storeSlug ?? null,
          storeName: sctx.storeName ?? null,
          themeId: sctx.themeId ?? null,
          draftThemeId: sctx.draftThemeId ?? null,
          commerceEnabled: sctx.commerceEnabled ?? null,
        },
      };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : 'unknown error';
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      logger.warn(
        { integrationId: ctx.integrationId, err: message },
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
