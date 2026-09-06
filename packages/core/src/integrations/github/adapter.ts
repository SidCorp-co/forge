/**
 * GitHub integration adapter — the inbound half of the provider.
 *
 * Replaces the second webhook path that used to live inside `POST /in/:slug`,
 * keyed on `projects.webhookSecret`: one shared secret per project, no
 * environment split, no delivery log, no health, no breaker. Measured on the
 * live fleet 2026-09-06, that path had 0 of 41 projects configured and had
 * produced 0 of 4,436 issues, so there was nothing in the field to keep
 * working.
 *
 * Outbound (open a pull request, review one) lands next and is refused by name
 * until it does.
 */

import { handleGitHubEvent } from '../../webhooks/github-adapter.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import { recordDelivery } from '../deliveries.js';
import { registerAdapter } from '../registry.js';
import { updateConnection } from '../store.js';
import type {
  AdapterContext,
  HealthCheckResult,
  InboundDispatchInput,
  InboundDispatchResult,
  IntegrationAdapter,
} from '../types.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

export const githubAdapter: IntegrationAdapter<GitHubConfig, GitHubSecrets> = {
  provider: 'github',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: true,
    injectsMcp: false,
    hasEnvironments: false,
    prodConfirmGate: false,
    hasDeliveryLog: true,
  },

  // cm:guard 403 is NOT `needs_reauth` — GitHub answers 401 for a credential it does not recognise and 403 for one it does recognise and refuses (permission not granted to the App, SSO not authorised). Collapsing them tells the operator to reconnect when what they must do is grant a permission, and reconnecting reproduces the state exactly. This is the mislabel ISS-924 files against the coolify adapter; do not reproduce it here.
  async healthcheck(ctx: AdapterContext<GitHubConfig, GitHubSecrets>): Promise<HealthCheckResult> {
    const { owner, repo, installationId } = ctx.config ?? {};
    const base = (ctx.config?.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
    const { appId, privateKey } = ctx.secrets ?? {};

    const finish = async (status: HealthCheckResult['status'], message?: string) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthAt: new Date(),
      });
      return message === undefined ? { status } : { status, message };
    };

    if (!appId || !privateKey)
      return finish('error', 'this connection holds no GitHub App credential');
    if (!installationId) return finish('error', 'the App is not installed for this binding');
    if (!owner || !repo) return finish('error', 'no owner/repo configured for this binding');

    try {
      const token = await installationToken({
        appId,
        privateKey,
        installationId,
        ...(ctx.config?.apiBaseUrl ? { apiBaseUrl: ctx.config.apiBaseUrl } : {}),
      });
      const res = await fetch(
        `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
      );
      if (res.status === 403) {
        return finish(
          'error',
          `the App is installed but not permitted on ${owner}/${repo} (HTTP 403) — grant the permission on the installation rather than reconnecting`,
        );
      }
      if (res.status === 404) {
        return finish(
          'error',
          `${owner}/${repo} is not among the repositories this App was installed on`,
        );
      }
      if (!res.ok) return finish('error', `GitHub returned HTTP ${res.status}`);
      const body = (await res.json()) as { full_name?: string; default_branch?: string };
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        diagnostics: {
          repository: body.full_name,
          defaultBranch: body.default_branch,
          installationId,
        },
      };
    } catch (err) {
      if (err instanceof GitHubAuthError) {
        return finish(err.status === 401 ? 'needs_reauth' : 'error', err.message);
      }
      return finish('error', err instanceof Error ? err.message : String(err));
    }
  },

  dispatchOutbound() {
    throw new Error(
      'github: dispatchOutbound is not supported yet — the pull-request verbs are not implemented',
    );
  },

  async handleInbound(
    ctx: AdapterContext<GitHubConfig, GitHubSecrets>,
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult> {
    const eventType = input.headers['x-github-event'];
    if (!eventType) throw new Error('github webhook: x-github-event missing');

    if (!ctx.integrationSecret) {
      throw new Error('github: integration has no signing secret configured');
    }
    const signature = input.headers['x-hub-signature-256'] ?? null;
    if (!verifyHmacSignature(ctx.integrationSecret, input.rawBody, signature)) {
      throw new Error('github: signature verification failed');
    }

    const payload = input.payload as Parameters<typeof handleGitHubEvent>[2] & {
      action?: string;
      repository?: { full_name?: string };
    };

    // cm:guard match the repository before acting — a GitHub App signs every installation's deliveries with ONE webhook secret, so a valid signature proves the App sent it and says NOTHING about which binding it belongs to. Without this check the router's "first binding whose secret verifies" would hand a second repo's events to the first repo's binding, silently and with a 200.
    const arrived = payload?.repository?.full_name;
    const expected =
      ctx.config?.owner && ctx.config?.repo ? `${ctx.config.owner}/${ctx.config.repo}` : null;
    if (arrived && expected && arrived.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`github webhook: delivery is for ${arrived}, this binding is ${expected}`);
    }
    const guid = input.headers['x-github-delivery'];
    const deliveryId = await recordDelivery({
      bindingId: ctx.bindingId,
      direction: 'inbound',
      eventName: `${eventType}.${payload?.action ?? 'unknown'}`,
      payload,
      ...(guid ? { requestId: guid } : {}),
      status: 'ok',
    });

    const result = await handleGitHubEvent(ctx.projectId, eventType, payload);
    return { deliveryId, actions: result.actions };
  },
};

export function registerGitHubAdapter(): void {
  registerAdapter(githubAdapter as unknown as IntegrationAdapter);
}
