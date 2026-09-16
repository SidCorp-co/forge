/**
 * ISS-604 (P2b) — Rocket.Chat integration adapter (connection-only archetype).
 *
 * Stores the bot credential + server URL as a standard integration connection
 * so it's created/rotated/health-checked through the same machinery as
 * coolify/sentry. It does NOT dispatch or receive webhooks — the bot-user DDP
 * connection (P2c) reads the connection out-of-band. `healthcheck` verifies the
 * credential against `GET /api/v1/me`, powering the test-connection UI.
 */

import { updateConnection } from '../store.js';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import {
  ROCKETCHAT_BINDING_CONFIG_KEYS,
  rocketchatConfigBase,
  rocketchatSecretsSchema,
} from './schemas.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

const unsupported = (op: string): never => {
  throw new Error(`rocketchat: ${op} is not supported (connection-only provider)`);
};

const rocketChatAdapterMethods: IntegrationAdapterMethods<RocketChatConfig, RocketChatSecrets> = {

  async healthcheck(
    ctx: AdapterContext<RocketChatConfig, RocketChatSecrets>,
  ): Promise<HealthCheckResult> {
    const serverUrl = ctx.config?.serverUrl?.replace(/\/+$/, '');
    const { authToken, userId } = ctx.secrets ?? {};

    const fail = async (status: HealthCheckResult['status'], message: string) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthAt: new Date(),
      });
      return { status, message };
    };

    if (!serverUrl) return fail('error', 'no Rocket.Chat serverUrl configured');
    if (!authToken || !userId) return fail('error', 'no Rocket.Chat bot credentials configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${serverUrl}/api/v1/me`, {
        headers: { 'X-Auth-Token': authToken, 'X-User-Id': userId, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return fail('needs_reauth', `Rocket.Chat rejected the bot credential (HTTP ${res.status})`);
      }
      if (!res.ok) return fail('error', `Rocket.Chat /api/v1/me returned HTTP ${res.status}`);
      const body = (await res.json()) as { success?: boolean; username?: string };
      if (!body?.success && !body?.username) return fail('error', 'Rocket.Chat /api/v1/me not ok');
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return { status: 'ok', diagnostics: { username: body.username, serverUrl } };
    } catch (err) {
      return fail('error', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  },

  dispatchOutbound: () => unsupported('dispatchOutbound'),
  handleInbound: () => unsupported('handleInbound'),
};

/**
 * Rocket.Chat's declaration. No agent path at all: the bot posts on the project's behalf through
 * core's own delivery path, and there is nothing here for an agent to call, so the grant column on
 * a rocketchat binding is inert and no screen offers it a control.
 */
export const rocketchatIntegration = declareIntegration<RocketChatConfig, RocketChatSecrets>({
  provider: 'rocketchat',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    agentPath: { kind: 'none' },
  },
  schemas: {
    connectionConfig: rocketchatConfigBase,
    bindingConfig: rocketchatConfigBase,
    patchConfig: rocketchatConfigBase.partial(),
    secrets: rocketchatSecretsSchema,
    patchSecrets: rocketchatSecretsSchema.partial(),
    primaryCredentialField: 'authToken',
    previousCredentialField: 'previousAuthToken',
    // cm:why the bot's `userId` travels with the token but is independently writable: it is the account the PAT belongs to, and correcting it is not a credential rotation. Every other provider's secret fields arrive together or not at all.
    independentSecretFields: ['userId'],
    bindingConfigKeys: ROCKETCHAT_BINDING_CONFIG_KEYS,
  },
  usage: null,
  presentation: {
    label: 'Rocket.Chat',
    alwaysStageKeyed: false,
    neverCheckedDetail: 'never test-connected',
    cardMeta: (config) => {
      const cfg = config as { serverUrl?: string; rids?: string[] };
      return { serverUrl: cfg.serverUrl ?? null, rids: cfg.rids ?? null };
    },
  },
  adapter: rocketChatAdapterMethods,
});

export const rocketChatAdapter = rocketChatAdapterMethods;
