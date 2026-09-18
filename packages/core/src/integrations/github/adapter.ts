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
 * Outbound (open a pull request, review one) is not implemented, and the
 * declaration says so rather than promising it: `canDispatch: false` with no
 * `dispatchOutbound` at all, which `check-integration-declarations.mjs` holds to
 * the adapter since ISS-1062. Each face turns on in the change that implements
 * it — the check run is ISS-1072, the merge ISS-1073.
 */

import type { BindingRole } from '../../db/schema.js';
import { handleGitHubEvent } from '../../webhooks/github-adapter.js';
import { verifyHmacSignature } from '../../webhooks/hmac.js';
import { recordDelivery } from '../deliveries.js';
import { type IntegrationConnectionRow, updateConnection } from '../store.js';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type InboundDispatchInput,
  type InboundDispatchResult,
  type IntegrationAdapterMethods,
} from '../types.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { githubInboundSecret, syncRepoUrlFromGitHubBinding } from './bind-effects.js';
import { GITHUB_BINDING_CONFIG_KEYS, githubConfigBase, githubSecretsSchema } from './schemas.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

const githubAdapterMethods: IntegrationAdapterMethods<GitHubConfig, GitHubSecrets> = {
  inboundSecret: (connection) => githubInboundSecret(connection as IntegrationConnectionRow),
  onBindingCreated: async ({ projectId, role, config }) => ({
    repoUrl: await syncRepoUrlFromGitHubBinding({
      projectId,
      role: role as BindingRole,
      config: config as GitHubConfig,
    }),
  }),

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

    const result = await handleGitHubEvent(
      {
        projectId: ctx.projectId,
        bindingId: ctx.bindingId,
        config: ctx.config ?? {},
        secrets: ctx.secrets ?? {},
      },
      eventType,
      payload,
    );
    return { deliveryId, actions: result.actions };
  },
};

/**
 * GitHub's declaration.
 *
 * `core-mediated` since ISS-1074: Forge holds the App credential and makes the call, and an agent
 * asks for it through `forge_github`. It said `none` until then, and the sentence beside it — "the
 * agent works the repository with the runner box's own git credentials" — was true of the TREE and
 * wrong about the repository: reading a diff, reading a failing job's log and writing a review are
 * not git, and every one of them was being done by shelling out to `gh` under a person's account.
 * Tree work is still git's and is out of scope here.
 */
export const githubIntegration = declareIntegration<GitHubConfig, GitHubSecrets>({
  provider: 'github',
  capabilities: {
    canDispatch: false,
    canReceiveWebhook: true,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: true,
    multiBinding: false,
    webhookHeader: 'x-github-event',
    webhookSignatureHeader: 'x-hub-signature-256',
    structuredRollback: false,
    // cm:guard `core-mediated` and NOT `direct-mcp`, and the difference is the whole of ISS-1071's rule 2: `direct-mcp` renders the credential into a runner box's MCP config and puts Forge outside the call path. This App's private key is the identity every write to the repository is made under — it can open, comment and review on every repository the installation covers — so there is no version of handing it to a box that is worth the round trip it saves. Core holds it, core makes the call, and `forge_github` is where an agent asks.
    // cm:guard `forge_github` is the WHOLE list on purpose. A verb that merges is not missing from it, it is refused by it: merging is a kernel transition on the dispatch face (ISS-1073), where the same operation stamps `merged_at`. `agent-ops.ts:kernelVerbRefusal` is the sentence a caller naming one gets.
    agentPath: { kind: 'core-mediated', tools: ['forge_github'] },
  },
  schemas: {
    connectionConfig: githubConfigBase,
    bindingConfig: githubConfigBase,
    patchConfig: githubConfigBase.partial(),
    secrets: githubSecretsSchema,
    patchSecrets: githubSecretsSchema.partial(),
    primaryCredentialField: 'privateKey',
    previousCredentialField: 'previousPrivateKey',
    independentSecretFields: [],
    bindingConfigKeys: GITHUB_BINDING_CONFIG_KEYS,
  },
  // cm:why SHORT: this reaches every prompt on every project with github connected, and a playbook here is a tax each of them pays per job. What an action takes and what it answers lives in the tool's own `description`, which is what a model reads at the moment it calls.
  usage: {
    hint: "Read and write this repository through `forge_github` — a pull request diff, a failing check run's log, a comment, a new pull request, a review request, a review verdict. Never `gh`: the App is the identity, and no credential reaches this box. Nothing here merges.",
  },
  // cm:why null rather than a card of its own — the GitHub card `status-service.ts` builds comes from the PROJECT'S repository and its devices' push credentials, which is a different subject from a binding's health. A second github card keyed off a binding would collide with it by key.
  presentation: null,
  adapter: githubAdapterMethods,
});

export const githubAdapter = githubAdapterMethods;
