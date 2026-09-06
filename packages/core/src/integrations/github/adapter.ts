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

  // cm:guard 403 is NOT `needs_reauth` — GitHub answers 401 for a token it does not recognise and 403 for one it does recognise and refuses (missing scope, SSO not authorised, repo not visible). Collapsing them tells the operator to replace a credential that is fine, and re-entering the same token reproduces the state exactly. This is the mislabel ISS-924 files against the coolify adapter; do not reproduce it here.
  async healthcheck(ctx: AdapterContext<GitHubConfig, GitHubSecrets>): Promise<HealthCheckResult> {
    const { owner, repo } = ctx.config ?? {};
    const base = (ctx.config?.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
    const token = ctx.secrets?.token;

    const finish = async (status: HealthCheckResult['status'], message?: string) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthAt: new Date(),
      });
      return message === undefined ? { status } : { status, message };
    };

    if (!token) return finish('error', 'no GitHub token configured');
    if (!owner || !repo) return finish('error', 'no owner/repo configured for this binding');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        },
      );
      if (res.status === 401) {
        return finish('needs_reauth', 'GitHub does not recognise this token (HTTP 401)');
      }
      if (res.status === 403) {
        const scopes = res.headers.get('x-oauth-scopes');
        return finish(
          'error',
          `GitHub refused this token for ${owner}/${repo} (HTTP 403). The token is valid; widen its scope or authorise it for the org${scopes ? ` — it currently carries: ${scopes}` : ''}.`,
        );
      }
      if (res.status === 404) {
        return finish('error', `${owner}/${repo} is not visible to this token (HTTP 404)`);
      }
      if (!res.ok) return finish('error', `GitHub returned HTTP ${res.status}`);
      const body = (await res.json()) as { full_name?: string; default_branch?: string };
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        diagnostics: { repository: body.full_name, defaultBranch: body.default_branch },
      };
    } catch (err) {
      return finish('error', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
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

    const payload = input.payload as Parameters<typeof handleGitHubEvent>[2] & { action?: string };
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
