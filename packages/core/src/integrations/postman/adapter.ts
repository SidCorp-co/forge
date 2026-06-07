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
import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
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
  // MCP-injection archetype: injects mcpServers.postman into the runner; core
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
      return { status: 'error', message: 'no Postman API key configured' };
    }

    const base = postmanRestBase(ctx.config.region ?? 'us');

    // One attempt with a given key. Returns the parsed result OR a 401/403
    // sentinel so the caller can fall back to the previous key (ISS-405 dual-
    // token rotation, mirrors coolify/client.ts:50-79).
    type AttemptResult =
      | { kind: 'ok'; body: PostmanMeResponse }
      | { kind: 'unauthorized'; status: number }
      | { kind: 'http-error'; status: number };
    async function attempt(key: string): Promise<AttemptResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ME_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/me`, {
          method: 'GET',
          headers: { 'X-Api-Key': key, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { kind: 'unauthorized', status: res.status };
          }
          return { kind: 'http-error', status: res.status };
        }
        const body = (await res.json()) as PostmanMeResponse;
        return { kind: 'ok', body };
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      let result = await attempt(apiKey);
      // If the primary key is rejected AND the operator just rotated within
      // the overlap window, retry once with the retained previous key.
      if (
        result.kind === 'unauthorized' &&
        ctx.secrets.previousApiKey &&
        isPreviousCredentialValid(ctx.secrets)
      ) {
        result = await attempt(ctx.secrets.previousApiKey);
      }

      if (result.kind !== 'ok') {
        await updateConnection(ctx.connectionId, {
          lastHealthStatus: 'error',
          lastHealthAt: new Date(),
        });
        const reason =
          result.kind === 'unauthorized'
            ? 'invalid Postman API key'
            : `Postman API error (HTTP ${result.status})`;
        return { status: 'error', message: reason, diagnostics: { httpStatus: result.status } };
      }

      const user = result.body.user ?? {};
      await updateConnection(ctx.connectionId, {
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
      const message = err instanceof Error ? err.message : 'unknown error';
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: message },
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
