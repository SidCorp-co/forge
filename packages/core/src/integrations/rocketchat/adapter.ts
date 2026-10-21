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
import { thrownDiagnostics } from '../unreached.js';
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
  onConnectionChanged: (connectionId) => {
    void import('./connection-manager.js')
      .then((m) => m.requestRocketChatReload(connectionId))
      .catch(() => {});
  },

  async healthcheck(
    ctx: AdapterContext<RocketChatConfig, RocketChatSecrets>,
  ): Promise<HealthCheckResult> {
    const serverUrl = ctx.config?.serverUrl?.replace(/\/+$/, '');
    const { authToken, userId } = ctx.secrets ?? {};

    const fail = async (
      status: HealthCheckResult['status'],
      message: string,
      diagnostics?: Record<string, unknown>,
    ) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthAt: new Date(),
      });
      return { status, message, ...(diagnostics ? { diagnostics } : {}) };
    };

    if (!serverUrl)
      return fail('error', 'No Rocket.Chat server address is saved on this connection.');
    if (!authToken || !userId)
      return fail('error', 'No Rocket.Chat bot credential is saved on this connection.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${serverUrl}/api/v1/me`, {
        headers: { 'X-Auth-Token': authToken, 'X-User-Id': userId, Accept: 'application/json' },
        signal: controller.signal,
      });
      // Whether the server at the saved address is Rocket.Chat is what its answer is about, so each
      // answer is said of that server, as Coolify's are (ISS-1421 r20, criterion 176).
      const server = `The server at ${hostOf(serverUrl)}`;
      const ofAddress = { httpStatus: res.status, saidOfAddress: true };
      if (res.status === 401 || res.status === 403)
        return fail(
          'needs_reauth',
          `${server} refused the bot credential with HTTP ${res.status}.`,
          ofAddress,
        );
      if (!res.ok)
        return fail(
          'error',
          `${server} answered HTTP ${res.status} when asked who the bot is.`,
          ofAddress,
        );
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        username?: string;
      } | null;
      if (!body?.success && !body?.username)
        return fail(
          'error',
          `${server} answered, but did not say who the bot is, so it may not be Rocket.Chat.`,
          ofAddress,
        );
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return { status: 'ok', diagnostics: { username: body.username, serverUrl } };
    } catch (err) {
      return fail(
        'error',
        err instanceof Error ? err.message : String(err),
        thrownDiagnostics(err),
      );
    } finally {
      clearTimeout(timer);
    }
  },

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
    inboundUnprompted: false,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: false,
    multiBinding: false,
    structuredRollback: false,
    agentPath: { kind: 'none' },
  },
  schemas: {
    connectionConfig: rocketchatConfigBase,
    connectionPatchConfig: rocketchatConfigBase.partial(),
    bindingConfig: rocketchatConfigBase,
    patchConfig: rocketchatConfigBase.partial(),
    secrets: rocketchatSecretsSchema,
    patchSecrets: rocketchatSecretsSchema.partial(),
    primaryCredentialField: 'authToken',
    previousCredentialField: null,
    independentSecretFields: ['userId'],
    bindingConfigKeys: ROCKETCHAT_BINDING_CONFIG_KEYS,
  },
  usage: null,
  presentation: {
    label: 'Rocket.Chat',
    alwaysStageKeyed: false,
    cardMeta: (config) => {
      const cfg = config as { serverUrl?: string; rids?: string[] };
      return { serverUrl: cfg.serverUrl ?? null, rids: cfg.rids ?? null };
    },
  },
  adapter: rocketChatAdapterMethods,
});

export const rocketChatAdapter = rocketChatAdapterMethods;

/** The host a saved address names, or the address itself where it is not one. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
