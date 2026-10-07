import { logger } from '../../lib/logger.js';
import { say } from '@forge/contracts/said';
import {
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
  updateConnection,
} from '../index.js';
import { callSentry, sentryRefusalHealth } from './call.js';
import { sentryRestBase } from './endpoints.js';
import { dispatchSentryOutbound } from './issues.js';
import { SentryRefusal } from './refusals.js';
import { buildSentryMcpEntry } from './resolver.js';
import { SENTRY_BINDING_CONFIG_KEYS, sentryConfigBase, sentrySecretsSchema } from './schemas.js';
import { readTargets, renderSentryTargetsLine } from './targets.js';
import type { SentryConfig, SentrySecrets } from './types.js';

/** Minimal shape of a Sentry org returned by `GET /api/0/organizations/`. */
interface SentryOrg {
  id?: number | string;
  slug?: string;
  name?: string;
}

const sentryAdapterMethods: IntegrationAdapterMethods<SentryConfig, SentrySecrets> = {
  async healthcheck(ctx): Promise<HealthCheckResult> {
    const authToken = ctx.secrets?.authToken;
    if (!authToken || !ctx.config?.host) {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'error',
        lastHealthAt: new Date(),
      });
      return {
        status: 'error',
        message: authToken ? 'no Sentry host configured' : 'no Sentry auth token configured',
      };
    }
    // `callSentry` makes the previous-token retry and writes the connection's health either way.
    try {
      const body = await callSentry(
        ctx,
        `${sentryRestBase(ctx.config.host)}/api/0/organizations/`,
        'GET',
      );
      const orgs = Array.isArray(body) ? (body as SentryOrg[]) : [];
      return {
        status: 'ok',
        message: orgs.length
          ? `Authenticated — ${orgs.length} organization(s) accessible`
          : 'Sentry auth token is valid',
        // Only non-secret identity fields — never the token.
        diagnostics: {
          organizations: orgs
            .slice(0, 10)
            .map((o) => ({ id: o.id ?? null, slug: o.slug ?? null, name: o.name ?? null })),
        },
      };
    } catch (err) {
      if (!(err instanceof SentryRefusal)) throw err;
      logger.warn(
        { connectionId: ctx.connectionId, bindingId: ctx.bindingId, err: err.message },
        'sentry: healthcheck failed',
      );
      return {
        status: sentryRefusalHealth(err.reason),
        message: err.message,
        ...(err.httpStatus !== null ? { diagnostics: { httpStatus: err.httpStatus } } : {}),
      };
    }
  },

  // The generic door (`registry.ts:dispatchThrough`) lands here; the work is in `issues.ts` so this
  // file stays the declaration rather than becoming the client.
  dispatchOutbound: dispatchSentryOutbound,

  // Sentry is an error source read by `error-intake/pull.ts`; it has no inbound door.
  async handleInbound() {
    throw new Error('sentry: handleInbound is not supported — errors are pulled on a schedule');
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
    inboundUnprompted: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: true,
    multiBinding: false,
    structuredRollback: false,
    agentPath: {
      kind: 'direct-mcp',
      tools: ['forge_sentry'],
      serverName: 'sentry',
      previewSecrets: { authToken: '[redacted]' },
      justification:
        'Core mediates the issue read itself: `forge_sentry` answers `list` and `get` against this binding without the credential leaving core. Everything past an issue — events, traces, Seer, the search syntax Sentry keeps adding to — has no core-mediated route, and the hosted https MCP is OAuth-only and unusable against a self-hosted instance, so reaching any of it means the runner executing `npx @sentry/mcp-server` with the token in its environment.',
      buildEntry: (config, secrets) => {
        const authToken = secrets.authToken;
        if (typeof authToken !== 'string' || authToken.length === 0) return null;
        return buildSentryMcpEntry(config as SentryConfig, authToken);
      },
    },
  },
  schemas: {
    connectionConfig: sentryConfigBase,
    connectionPatchConfig: sentryConfigBase.partial(),
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
    hint: '`forge_sentry` reads this error stream on demand — `list` narrowed by release, window, path or request id, `get` for one issue. It changes nothing in Sentry and files nothing; the scheduled pull is what files.',
    renderExtra: (config) => {
      const read = readTargets(config as SentryConfig);
      if ('refusal' in read) return `  - refused (${read.refusal.reason}): ${read.refusal.message}`;
      return read.targets.length > 0 ? renderSentryTargetsLine(read.targets) : null;
    },
  },
  presentation: {
    label: 'Sentry',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverTested'),
    // ISS-526 — the multi-target shape: count plus the first target's org for the card subtitle;
    // a config in the retired shape is shown as its refusal, never as zero targets.
    cardMeta: (config) => {
      const cfg = config as SentryConfig;
      const read = readTargets(cfg);
      const targets = 'refusal' in read ? [] : read.targets;
      return {
        host: cfg.host ?? null,
        organizationSlug: targets[0]?.organizationSlug ?? null,
        targetCount: targets.length,
        ...('refusal' in read ? { refusal: read.refusal } : {}),
      };
    },
  },
  adapter: sentryAdapterMethods,
});
