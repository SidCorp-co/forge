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
 *
 * ISS-532 adoption point: Sentry event payloads are untrusted, but today they
 * reach the agent only via the runner-injected `@sentry/mcp-server` — they do
 * NOT pass through any core serializer, so there is no prompt-assembly
 * chokepoint to harden here. IF core ever ingests Sentry event text into an
 * issue/comment/prompt (e.g. an auto-file-issue-from-event path), route that
 * text through `markUntrusted()` from `prompt/sanitize.ts` at the point of
 * ingestion — same as the issue/comment/attachment chokepoints.
 */

import { logger } from '../../logger.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
import {
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import { buildSentryMcpEntry } from './resolver.js';
import { renderSentryTargetsLine, resolveSentryTargets } from './targets.js';
import {
  SENTRY_BINDING_CONFIG_KEYS,
  sentryConfigBase,
  sentrySecretsSchema,
} from './schemas.js';
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

const sentryAdapterMethods: IntegrationAdapterMethods<SentryConfig, SentrySecrets> = {

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

/**
 * Sentry's declaration. `direct-mcp`, and the sharpest case for why the kind names a risk rather
 * than a transport: the runner EXECUTES `npx @sentry/mcp-server` with the auth token in its
 * environment, so the grant is a decision about a box running a third-party package with a
 * project's credential, not about a URL.
 */
export const sentryIntegration = declareIntegration<SentryConfig, SentrySecrets>({
  provider: 'sentry',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    structuredRollback: false,
    agentPath: {
      kind: 'direct-mcp',
      tools: [],
      serverName: 'sentry',
      previewSecrets: { authToken: '[redacted]' },
      justification:
        'Self-hosted Sentry is reached only through its own MCP server, which the runner executes with the token in its environment; the hosted https MCP is OAuth-only and unusable for a self-hosted instance. Forge has no issue-search API of its own to mediate, so the token reaches the box or the agent cannot read an error at all.',
      buildEntry: (config, secrets) => {
        const authToken = secrets.authToken;
        if (typeof authToken !== 'string' || authToken.length === 0) return null;
        return buildSentryMcpEntry(config as SentryConfig, authToken);
      },
    },
  },
  schemas: {
    connectionConfig: sentryConfigBase,
    bindingConfig: sentryConfigBase,
    patchConfig: sentryConfigBase.partial(),
    secrets: sentrySecretsSchema,
    patchSecrets: sentrySecretsSchema.partial(),
    primaryCredentialField: 'authToken',
    previousCredentialField: 'previousAuthToken',
    independentSecretFields: [],
    bindingConfigKeys: SENTRY_BINDING_CONFIG_KEYS,
  },
  usage: {
    // No `hint`: the generic line is what Sentry rendered before ISS-1071 and this change is about
    // WHERE the knowledge lives, not about rewriting what an agent is told.
    renderExtra: (config) => {
      const targets = resolveSentryTargets(config as SentryConfig);
      return targets.length > 0 ? renderSentryTargetsLine(targets) : null;
    },
  },
  presentation: {
    label: 'Sentry',
    alwaysStageKeyed: false,
    neverCheckedDetail: 'never test-connected',
    // ISS-526 — the multi-target shape: count plus the first target's org for the card subtitle,
    // with a back-compat read of the legacy single-slug connection.
    cardMeta: (config) => {
      const cfg = config as SentryConfig;
      const targets = resolveSentryTargets(cfg);
      return {
        host: cfg.host ?? null,
        organizationSlug: targets[0]?.organizationSlug ?? cfg.organizationSlug ?? null,
        targetCount: targets.length,
      };
    },
  },
  adapter: sentryAdapterMethods,
});

export const sentryAdapter = sentryAdapterMethods;
