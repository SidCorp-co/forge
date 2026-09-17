/**
 * ISS-524 / ISS-1085 — Sentry integration adapter.
 *
 * Sentry reaches Forge's agents through the official `@sentry/mcp-server` injected into the runner
 * (see `resolver.ts`), and core reaches Sentry through three outbound calls of its own: read one
 * issue, set one issue's status, and list a target's unresolved issues (`issues.ts`). Those two are the half of the Forge/Sentry loop that
 * lets a Forge issue closed with a merged SHA tell Sentry `resolvedInNextRelease` — not bare
 * `resolved`, because merged is not serving. Core also makes the test-connection call
 * `GET /api/0/organizations/`, which validates the auth token and surfaces the accessible orgs to
 * the config UI.
 *
 * Sentry text DOES now reach a Forge issue — `intake.ts`, the scheduled pull (slice 3) — and that
 * is a pull core initiates, not a surface Sentry pushes to. `handleInbound` still refuses by name,
 * because there is still no webhook: that is slice 4, and the issue's own body says why it comes
 * second (a lost webhook delivery is lost for good, while a scheduled pull catches up on the next
 * tick).
 *
 * The chokepoint that omission used to stand in for is now real code and is described where it
 * lives, in `intake.ts`'s header. In short: every free-text field is `sanitizeUntrusted`-stripped on
 * the way in (`issues.ts:text()`), the DATA frame is applied at the agent-facing projection rather
 * than at the database write — `prompt/user.ts` and `mcp/tools/forge-issues.ts:serialize`, both of
 * which would DESTROY a stored frame, since `markUntrusted` strips frame tokens from its own input
 * — and the row the pull writes is a closed shape with no priority, category or label for Sentry
 * text to steer. The one agent-facing projection that does not frame is `serializeListRow`, priced
 * in its own `cm:why` and recorded at
 * `docs/proposals/an-mcp-list-title-is-char-stripped-and-not-framed.md`.
 */
import { logger } from '../../logger.js';
import { isPreviousCredentialValid } from '../rotation.js';
import { updateConnection } from '../store.js';
import {
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import { sentryRestBase } from './endpoints.js';
import { dispatchSentryOutbound } from './issues.js';
import { buildSentryMcpEntry } from './resolver.js';
import { SENTRY_BINDING_CONFIG_KEYS, sentryConfigBase, sentrySecretsSchema } from './schemas.js';
import { renderSentryTargetsLine, resolveSentryTargets } from './targets.js';
import type { SentryConfig, SentrySecrets } from './types.js';

const PROBE_TIMEOUT_MS = 15_000;

/** Minimal shape of a Sentry org returned by `GET /api/0/organizations/`. */
interface SentryOrg {
  id?: number | string;
  slug?: string;
  name?: string;
}

const notSupported = (op: string): never => {
  // There is no inbound surface, on purpose — see this file's header.
  throw new Error(`sentry: ${op} is not supported (this provider has no inbound surface)`);
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

  // The generic door (`registry.ts:dispatchThrough`) lands here; the work is in `issues.ts` so this
  // file stays the declaration rather than becoming the client.
  dispatchOutbound: dispatchSentryOutbound,

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
    canDispatch: true,
    canReceiveWebhook: false,
    canDeploy: false,
    liveConfirmGate: false,
    // cm:why true follows `canDispatch`: every outbound call writes an `integration_deliveries` row,
    // and a provider whose rows exist while its declaration says the log is meaningless is a state
    // that lies — the connection drawer would hide deliveries an operator has to be able to read.
    hasDeliveryLog: true,
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
