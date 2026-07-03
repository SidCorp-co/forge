/**
 * ISS-604 (P2b) — Rocket.Chat integration adapter (connection-only archetype).
 *
 * Stores the bot credential + server URL as a standard integration connection
 * so it's created/rotated/health-checked through the same machinery as
 * coolify/sentry. It does NOT dispatch or receive webhooks — the bot-user DDP
 * connection (P2c) reads the connection out-of-band. `healthcheck` verifies the
 * credential against `GET /api/v1/me`, powering the test-connection UI.
 */

import { registerAdapter } from '../registry.js';
import { updateConnection } from '../store.js';
import type { AdapterContext, HealthCheckResult, IntegrationAdapter } from '../types.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

const unsupported = (op: string): never => {
  throw new Error(`rocketchat: ${op} is not supported (connection-only provider)`);
};

export const rocketChatAdapter: IntegrationAdapter<RocketChatConfig, RocketChatSecrets> = {
  provider: 'rocketchat',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: false,
    injectsMcp: false,
    hasEnvironments: false,
    prodConfirmGate: false,
    hasDeliveryLog: false,
  },

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

export function registerRocketChatAdapter(): void {
  registerAdapter(rocketChatAdapter);
}
