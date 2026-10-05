import type { BindingRole } from '../../db/schema.js';
import {
  type AdapterContext,
  applyClaimedInbound,
  declareIntegration,
  type HealthCheckResult,
  type InboundDispatchInput,
  type InboundDispatchResult,
  type InboundFact,
  type IntegrationAdapterMethods,
  updateConnection,
} from '../index.js';
import { sourceHostMismatch } from '../source-host/index.js';
import { compareBoundRepository } from './bind-effects.js';
import { githubGitCredential } from './git-credential.js';
import { readAppHookConfig } from './hook-config.js';
import { checkInstallationGrant } from './installation-permissions.js';
import {
  GitHubAuthError,
  installationOctokit,
  mintInstallationToken,
  responseOf,
} from './octokit.js';
import { type GitHubEventPayload, handleGitHubEvent } from './projection-events.js';
import { GITHUB_BINDING_CONFIG_KEYS, githubConfigBase, githubSecretsSchema } from './schemas.js';
import { githubHostOf, githubSourceHost } from './source-host.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

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

type InstallationCred = Parameters<typeof installationOctokit>[0];

/** Read the bound repository as the installation; an HTTP refusal is told in the operator's terms. */
async function readRepository(
  cred: InstallationCred,
  owner: string,
  repo: string,
): Promise<{ body: { full_name?: string; default_branch?: string } } | { refused: string }> {
  try {
    const res = await installationOctokit(cred).request({
      method: 'GET',
      url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      request: { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    });
    return { body: res.data as { full_name?: string; default_branch?: string } };
  } catch (err) {
    const status = responseOf(err)?.status;
    if (status === undefined) throw err;
    if (status === 403) {
      return {
        refused: `the App is installed but not permitted on ${owner}/${repo} (HTTP 403) — grant the permission on the installation rather than reconnecting`,
      };
    }
    if (status === 404) {
      return {
        refused: `${owner}/${repo} is not among the repositories this App was installed on`,
      };
    }
    return { refused: `GitHub returned HTTP ${status}` };
  }
}

/**
 * What the installation is not allowed to do that Forge's code asks of it (ISS-1153): an App
 * granted less answered every probe above and reported `ok` while it could not merge. It is
 * collected beside the webhook fault rather than returned first, so one probe names both.
 */
async function grantShortfall(
  args: Parameters<typeof checkInstallationGrant>[0],
): Promise<string | null> {
  const grant = await checkInstallationGrant(args);
  return grant.kind === 'unread' ? grant.reason : grant.kind === 'short' ? grant.message : null;
}

const githubAdapterMethods: IntegrationAdapterMethods<GitHubConfig, GitHubSecrets> = {
  inboundSecretField: 'webhookSecret',
  inboundSecretHome:
    "the GitHub App's settings (Developer settings → GitHub Apps → the App → Webhook), as its Webhook secret",
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
    const { appId, privateKey } = ctx.secrets ?? {};
    // The sentence goes to the connection beside the status (ISS-1140): a verdict with no why
    // leaves the operator reading `error` an hour later with nothing to act on.
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

    const apiBase = ctx.config?.apiBaseUrl ? { apiBaseUrl: ctx.config.apiBaseUrl } : {};
    const repository = `${owner}/${repo}`;
    try {
      const cred = { appId, privateKey, installationId, ...apiBase };
      await mintInstallationToken(cred);
      const read = await readRepository(cred, owner, repo);
      if ('refused' in read) return finish('error', read.refused);
      const inbound = await observeInboundEndpoint(ctx.connectionId, {
        appId,
        privateKey,
        repository,
        ...apiBase,
      });
      const faults = [inbound.fault, await grantShortfall({ ...cred, repository })].filter(
        (f): f is string => f !== null,
      );
      if (faults.length > 0) return finish('degraded', faults.join(' '));
      await finish('ok');
      return {
        status: 'ok',
        diagnostics: {
          repository: read.body.full_name,
          defaultBranch: read.body.default_branch,
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
    const facts: InboundFact[] = [];
    const { deliveryId, result } = await applyClaimedInbound(
      {
        bindingId: ctx.bindingId,
        eventName: `${eventType}.${payload?.action ?? 'unknown'}`,
        payload,
        ...(guid ? { requestId: guid } : {}),
      },
      async () => ({
        actions: await handleGitHubEvent(
          {
            projectId: ctx.projectId,
            bindingId: ctx.bindingId,
            config: ctx.config ?? {},
            secrets: ctx.secrets ?? {},
            facts,
          },
          eventType,
          payload,
        ),
      }),
    );
    return { deliveryId, actions: (result?.actions ?? 0) + facts.length, facts };
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
