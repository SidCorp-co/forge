import type { BindingRole } from '../../db/schema.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { sourceHostMismatch } from '../source-host/bind.js';
import { type IntegrationConnectionRow, updateConnection } from '../store.js';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type InboundDispatchInput,
  type InboundDispatchResult,
  type InboundFact,
  type IntegrationAdapterMethods,
} from '../types.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { compareBoundRepository, githubInboundSecret } from './bind-effects.js';
import { githubGitCredential } from './git-credential.js';
import { readAppHookConfig } from './hook-config.js';
import { checkInstallationGrant } from './installation-permissions.js';
import { type GitHubEventPayload, handleGitHubEvent } from './projection-events.js';
import { GITHUB_BINDING_CONFIG_KEYS, githubConfigBase, githubSecretsSchema } from './schemas.js';
import { githubHostOf, githubSourceHost } from './source-host.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

/**
 * Where GitHub is addressed for this App, stored as the ANSWER rather than as a verdict on it.
 *
 * ISS-1140: the App can be called OUT to and still be calling nothing IN. What this may decide is
 * limited on purpose — it rules only on what is true of the whole App, no address, an address
 * switched off, or a read that failed, because `last_health_status` is the CONNECTION's column and
 * one connection may serve bindings in several projects. Whether that one address is the one a
 * given BINDING needs is a per-binding question made at read time against this stored observation.
 */
async function observeInboundEndpoint(
  connectionId: string,
  args: { appId: string; privateKey: string; repository: string; apiBaseUrl?: string },
): Promise<{ fault: string | null; url: string | null }> {
  const hook = await readAppHookConfig({
    appId: args.appId,
    privateKey: args.privateKey,
    ...(args.apiBaseUrl ? { apiBaseUrl: args.apiBaseUrl } : {}),
  });
  const observedAt = new Date().toISOString();
  if (!hook.read) {
    await updateConnection(connectionId, {
      inboundEndpointObserved: { url: null, active: null, observedAt, readError: hook.reason },
    });
    return { fault: hook.reason, url: null };
  }
  await updateConnection(connectionId, {
    inboundEndpointObserved: { url: hook.url, active: hook.active, observedAt },
  });
  if (hook.url === null || hook.url === '') {
    return {
      fault: `${args.repository} answers, and this App holds no webhook address at all, so GitHub will never call in. Nothing that depends on a delivery — the pull request projection, the observed merge — can run for any project on this App.`,
      url: null,
    };
  }
  if (hook.active === false) {
    return {
      fault: `${args.repository} answers, and this App's webhook at ${hook.url} is switched off on GitHub's side, so GitHub will never call in. Switch it back on under the App's Settings, Webhook.`,
      url: hook.url,
    };
  }
  return { fault: null, url: hook.url };
}

const githubAdapterMethods: IntegrationAdapterMethods<GitHubConfig, GitHubSecrets> = {
  inboundSecret: (connection) => githubInboundSecret(connection as IntegrationConnectionRow),
  verifyBindingTarget: ({ projectId, connection, config }) =>
    sourceHostMismatch({
      projectId,
      provider: 'github',
      host: githubHostOf({ ...((connection.config ?? {}) as Record<string, unknown>), ...config }),
    }),
  onBindingCreated: async ({ projectId, role, config }) => ({
    repository: await compareBoundRepository({
      projectId,
      role: role as BindingRole,
      config: config as GitHubConfig,
    }),
  }),

  async healthcheck(ctx: AdapterContext<GitHubConfig, GitHubSecrets>): Promise<HealthCheckResult> {
    const { owner, repo, installationId } = ctx.config ?? {};
    const base = (ctx.config?.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
    const { appId, privateKey } = ctx.secrets ?? {};

    // The sentence goes to the connection beside the status. Until ISS-1140 the sweep dropped it,
    // so an operator reading `error` an hour later had the verdict and not one word of why.
    const finish = async (status: HealthCheckResult['status'], message?: string) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthDetail: message ?? null,
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

      const inbound = await observeInboundEndpoint(ctx.connectionId, {
        appId,
        privateKey,
        repository: `${owner}/${repo}`,
        ...(ctx.config?.apiBaseUrl ? { apiBaseUrl: ctx.config.apiBaseUrl } : {}),
      });

      // ISS-1153: every branch above turns on whether GitHub ANSWERS, and none of them on what the
      // installation is allowed to do. An App granted less than Forge's code asks of it passed all
      // of them and reported `ok` while it could not merge. Both faults are collected rather than
      // returned on the first, because an App with a switched-off webhook AND a missing permission
      // would otherwise be told about the webhook, and learn about the permission only on the probe
      // after that — the second round this issue exists to remove.
      const grant = await checkInstallationGrant({
        appId,
        privateKey,
        installationId,
        repository: `${owner}/${repo}`,
        ...(ctx.config?.apiBaseUrl ? { apiBaseUrl: ctx.config.apiBaseUrl } : {}),
      });
      const shortfall =
        grant.kind === 'unread' ? grant.reason : grant.kind === 'short' ? grant.message : null;

      const faults = [inbound.fault, shortfall].filter((f): f is string => f !== null);
      if (faults.length > 0) return finish('degraded', faults.join(' '));

      await updateConnection(ctx.connectionId, {
        lastHealthStatus: 'ok',
        lastHealthDetail: null,
        lastHealthAt: new Date(),
      });
      return {
        status: 'ok',
        diagnostics: {
          repository: body.full_name,
          defaultBranch: body.default_branch,
          installationId,
          webhookUrl: inbound.url,
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

    const payload = input.payload as GitHubEventPayload & {
      repository?: { full_name?: string };
    };

    const arrived = payload?.repository?.full_name;
    const expected =
      ctx.config?.owner && ctx.config?.repo ? `${ctx.config.owner}/${ctx.config.repo}` : null;
    if (arrived && expected && arrived.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`github webhook: delivery is for ${arrived}, this binding is ${expected}`);
    }
    const guid = input.headers['x-github-delivery'];
    const logged = {
      bindingId: ctx.bindingId,
      direction: 'inbound' as const,
      eventName: `${eventType}.${payload?.action ?? 'unknown'}`,
      payload,
      ...(guid ? { requestId: guid } : {}),
    };
    const facts: InboundFact[] = [];
    let actions: number;
    try {
      actions = await handleGitHubEvent(
        {
          projectId: ctx.projectId,
          bindingId: ctx.bindingId,
          config: ctx.config ?? {},
          secrets: ctx.secrets ?? {},
          facts,
        },
        eventType,
        payload,
      );
    } catch (err) {
      const deliveryId = await recordDelivery({ ...logged, status: 'failed' });
      await updateDelivery(deliveryId, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    // Logged once the event is applied, so an `ok` row says what happened rather than what arrived.
    const deliveryId = await recordDelivery({ ...logged, status: 'ok' });
    return { deliveryId, actions: actions + facts.length, facts };
  },
};

/**
 * GitHub's declaration.
 *
 * `core-mediated` since ISS-1074: Forge holds the App credential and makes the call, and an agent
 * asks for it through `forge_source`. It said `none` before
 * ISS-1074, and the sentence beside it — "the agent works the repository with the runner box's
 * own git credentials" — was true of the TREE and wrong about the repository: reading a diff,
 * reading a failing job's log and writing a review are not git, and every one of them was being
 * done by shelling out to `gh` under a person's account. Tree work is still git's and is out of
 * scope here.
 */
export const githubIntegration = declareIntegration<GitHubConfig, GitHubSecrets>({
  provider: 'github',
  capabilities: {
    // Merging is `POST /api/issues/:id/merge-pull-request` (`source-host/merge.ts`), never an
    // outbound verb, so nothing dispatches through this adapter.
    canDispatch: false,
    canReceiveWebhook: true,
    // GitHub calls on every push and pull request against a repository this App is installed on.
    // A live binding that has recorded nothing is a pipe that is not carrying, not a quiet repo.
    inboundUnprompted: true,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: true,
    multiBinding: false,
    webhookHeader: 'x-github-event',
    webhookSignatureHeader: 'x-hub-signature-256',
    structuredRollback: false,
    agentPath: { kind: 'core-mediated', tools: ['forge_source'] },
  },
  schemas: {
    connectionConfig: githubConfigBase,
    connectionPatchConfig: githubConfigBase.partial(),
    bindingConfig: githubConfigBase,
    patchConfig: githubConfigBase.partial(),
    secrets: githubSecretsSchema,
    patchSecrets: githubSecretsSchema.partial(),
    primaryCredentialField: 'privateKey',
    previousCredentialField: 'previousPrivateKey',
    independentSecretFields: [],
    bindingConfigKeys: GITHUB_BINDING_CONFIG_KEYS,
  },
  usage: {
    hint: "Read and write this repository through `forge_source` — a pull request diff, a failing check run's log, a comment, a new pull request, a review request, a review verdict. Never `gh`: the App is the identity, and no credential reaches this box. Nothing here merges.",
  },
  presentation: null,
  adapter: githubAdapterMethods,
  sourceHost: githubSourceHost,
  gitCredential: githubGitCredential,
});
