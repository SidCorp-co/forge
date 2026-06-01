/**
 * ISS-336 — Postman integration adapter.
 *
 * Postman's role in Forge is a ONE-WAY artifact sink (code → Postman) driven
 * entirely by the official Postman MCP server injected into the runner (see
 * `resolver.ts`). Core therefore does NOT implement outbound/inbound delivery
 * for this provider — the only direct REST call core makes is the
 * test-connection `GET /me` (decision 3), which validates the API key and
 * surfaces the authenticated user back to the config UI.
 */

import { logger } from '../../logger.js';
import { getAdapter, registerAdapter } from '../registry.js';
import { updateIntegration } from '../store.js';
import type { HealthCheckResult, IntegrationAdapter } from '../types.js';
import { postmanRestBase } from './endpoints.js';
import type { PostmanConfig, PostmanMeResponse, PostmanSecrets } from './types.js';

const ME_TIMEOUT_MS = 15_000;

const notSupported = (op: string): never => {
  // Postman is MCP-injection-only; no webhook/dispatch surface exists.
  throw new Error(`postman: ${op} is not supported (MCP-injection-only provider)`);
};

export const postmanAdapter: IntegrationAdapter<PostmanConfig, PostmanSecrets> = {
  provider: 'postman',

  async healthcheck(ctx): Promise<HealthCheckResult> {
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'no Postman API key configured' };
    }

    const base = postmanRestBase(ctx.config.region ?? 'us');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ME_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/me`, {
        method: 'GET',
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
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
            ? 'invalid Postman API key'
            : `Postman API error (HTTP ${res.status})`;
        return { status: 'error', message: reason, diagnostics: { httpStatus: res.status } };
      }

      const body = (await res.json()) as PostmanMeResponse;
      const user = body.user ?? {};
      await updateIntegration(ctx.integrationId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        message: user.username ? `Authenticated as ${user.username}` : 'Postman API key is valid',
        // Only non-secret identity fields — never the key.
        diagnostics: {
          user: {
            id: user.id ?? null,
            username: user.username ?? null,
            email: user.email ?? null,
            fullName: user.fullName ?? null,
          },
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
        'postman: healthcheck failed',
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

export function registerPostmanAdapter(): void {
  if (getAdapter('postman')) return;
  // biome-ignore lint/suspicious/noExplicitAny: registry accepts the adapter shape regardless of generic params
  registerAdapter(postmanAdapter as any);
}
