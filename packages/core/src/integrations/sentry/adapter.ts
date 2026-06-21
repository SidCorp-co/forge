/**
 * ISS-524 — Sentry integration adapter.
 *
 * Sentry's role in Forge is read-only log access for the project's agents,
 * delivered entirely by the official `@sentry/mcp-server` injected into the
 * runner (see `resolver.ts`). Core therefore does NOT implement outbound/inbound
 * delivery for this provider — the only direct REST call core makes is the
 * test-connection `GET /api/0/organizations/`, which validates the auth token
 * and surfaces the accessible orgs back to the config UI. Mirrors the postman
 * adapter (MCP-injection archetype).
 */

import { logger } from '../../logger.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
import type { HealthCheckResult, IntegrationAdapter } from '../types.js';
import { sentryRestBase } from './endpoints.js';
import type { SentryConfig, SentrySecrets } from './types.js';

const PROBE_TIMEOUT_MS = 15_000;

/** Minimal shape of a Sentry org returned by `GET /api/0/organizations/`. */
interface SentryOrg {
  id?: number | string;
  slug?: string;
  name?: string;
}

const notSupported = (op: string): never => {
  // Sentry is MCP-injection-only; no webhook/dispatch surface exists.
  throw new Error(`sentry: ${op} is not supported (MCP-injection-only provider)`);
};

export const sentryAdapter: IntegrationAdapter<SentryConfig, SentrySecrets> = {
  provider: 'sentry',
  // MCP-injection archetype: injects mcpServers.sentry into the runner; core
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
    const authToken = ctx.secrets?.authToken;
    if (!authToken) {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Sentry auth token configured' };
    }
    if (!ctx.config?.host) {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Sentry host configured' };
    }

    const base = sentryRestBase(ctx.config.host);

    // One attempt with a given token. Returns the parsed result OR a 401/403
    // sentinel so the caller can fall back to the previous token (ISS-405 dual-
    // token rotation, mirrors postman/adapter.ts).
    type AttemptResult =
      | { kind: 'ok'; body: SentryOrg[] }
      | { kind: 'unauthorized'; status: number }
      | { kind: 'http-error'; status: number };
    async function attempt(token: string): Promise<AttemptResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/api/0/organizations/`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { kind: 'unauthorized', status: res.status };
          }
          return { kind: 'http-error', status: res.status };
        }
        const body = (await res.json()) as SentryOrg[];
        return { kind: 'ok', body: Array.isArray(body) ? body : [] };
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      let result = await attempt(authToken);
      // If the primary token is rejected AND the operator just rotated within
      // the overlap window, retry once with the retained previous token.
      if (
        result.kind === 'unauthorized' &&
        ctx.secrets.previousAuthToken &&
        isPreviousCredentialValid(ctx.secrets)
      ) {
        result = await attempt(ctx.secrets.previousAuthToken);
      }

      if (result.kind !== 'ok') {
        // unauthorized = token rejected even after the ISS-405 previous-token
        // retry → the operator must re-enter it → needs_reauth (ISS-409). A
        // non-auth HTTP error stays a generic error.
        const healthStatus = result.kind === 'unauthorized' ? 'needs_reauth' : 'error';
        await updateConnection(ctx.connectionId, {
          lastHealthStatus: healthStatus,
          lastHealthAt: new Date(),
        });
        const reason =
          result.kind === 'unauthorized'
            ? 'invalid Sentry auth token'
            : `Sentry API error (HTTP ${result.status})`;
        return {
          status: healthStatus,
          message: reason,
          diagnostics: { httpStatus: result.status },
        };
      }

      const orgs = result.body;
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: orgs.length
          ? `Authenticated — ${orgs.length} organization(s) accessible`
          : 'Sentry auth token is valid',
        // Only non-secret identity fields — never the token.
        diagnostics: {
          organizations: orgs.slice(0, 10).map((o) => ({
            id: o.id ?? null,
            slug: o.slug ?? null,
            name: o.name ?? null,
          })),
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
        'sentry: healthcheck failed',
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

export function registerSentryAdapter(): void {
  if (getAdapter('sentry')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(sentryAdapter as any);
}
