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

import { PROVIDER_LABELS } from '@forge/contracts/health-words';
import { logger } from '../../logger.js';
import { updateConnection } from '../store.js';
import {
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import { thrownDiagnostics } from '../unreached.js';
import { postmanRestBase } from './endpoints.js';
import { buildPostmanMcpEntry } from './resolver.js';
import {
  POSTMAN_BINDING_CONFIG_KEYS,
  postmanConfigBase,
  postmanConfigSchema,
  postmanSecretsSchema,
} from './schemas.js';
import type { PostmanConfig, PostmanMeResponse, PostmanSecrets } from './types.js';

const ME_TIMEOUT_MS = 15_000;

const notSupported = (op: string): never => {
  // Postman is MCP-injection-only; no webhook/dispatch surface exists.
  throw new Error(`postman: ${op} is not supported (MCP-injection-only provider)`);
};

const postmanAdapterMethods: IntegrationAdapterMethods<PostmanConfig, PostmanSecrets> = {
  async healthcheck(ctx): Promise<HealthCheckResult> {
    const apiKey = ctx.secrets?.apiKey;
    if (!apiKey) {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return { status: 'error', message: 'No Postman API key is saved on this connection.' };
    }

    const base = postmanRestBase(ctx.config.region ?? 'us');

    // One attempt with the key. Returns the parsed result OR a 401/403 sentinel.
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
      // The key last saved alone: Postman keeps no previous key (ISS-1421 r20).
      const result = await attempt(apiKey);

      if (result.kind !== 'ok') {
        // unauthorized = the key was refused, so the operator must re-enter it →
        // needs_reauth (ISS-409). A non-auth HTTP error stays a generic error.
        const healthStatus = result.kind === 'unauthorized' ? 'needs_reauth' : 'error';
        await updateConnection(ctx.connectionId, {
          lastHealthStatus: healthStatus,
          lastHealthAt: new Date(),
        });
        const reason =
          result.kind === 'unauthorized'
            ? 'invalid Postman API key'
            : `Postman API error (HTTP ${result.status})`;
        return {
          status: healthStatus,
          message: reason,
          diagnostics: { httpStatus: result.status },
        };
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
      return { status: 'error', message, diagnostics: thrownDiagnostics(err) };
    }
  },

  async handleInbound() {
    return notSupported('handleInbound');
  },
};

/**
 * Postman's declaration. `direct-mcp`: the API key is rendered into the runner's MCP config and the
 * agent calls Postman itself, with Forge outside the call path.
 */
export const postmanIntegration = declareIntegration<PostmanConfig, PostmanSecrets>({
  provider: 'postman',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    inboundUnprompted: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    structuredRollback: false,
    agentPath: {
      kind: 'direct-mcp',
      tools: [],
      serverName: 'postman',
      previewSecrets: { apiKey: '[redacted]' },
      justification:
        'Postman exposes its workspace only through its own hosted MCP server, authenticated by the same API key. There is no Forge-side API to put in front of it, so the key reaches the runner or the agent reaches nothing.',
      buildEntry: (config, secrets) => {
        const apiKey = secrets.apiKey;
        if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
        return buildPostmanMcpEntry(config as PostmanConfig, apiKey);
      },
    },
  },
  schemas: {
    connectionConfig: postmanConfigSchema,
    connectionPatchConfig: postmanConfigBase.partial(),
    bindingConfig: postmanConfigSchema,
    patchConfig: postmanConfigBase.partial(),
    secrets: postmanSecretsSchema,
    patchSecrets: postmanSecretsSchema.partial(),
    primaryCredentialField: 'apiKey',
    previousCredentialField: null,
    independentSecretFields: [],
    bindingConfigKeys: POSTMAN_BINDING_CONFIG_KEYS,
  },
  usage: {
    hint:
      'Run API collections / target requests: read the write-target from\n' +
      '`GET /api/projects/:projectId/integrations/postman-target`, then use the `mcp__postman__*` tools.',
  },
  presentation: {
    label: PROVIDER_LABELS.postman,
    alwaysStageKeyed: false,
    cardMeta: (config) => {
      const cfg = config as { region?: string; mode?: string };
      return { region: cfg.region ?? 'us', mode: cfg.mode ?? 'minimal' };
    },
  },
  adapter: postmanAdapterMethods,
});

export const postmanAdapter = postmanAdapterMethods;
