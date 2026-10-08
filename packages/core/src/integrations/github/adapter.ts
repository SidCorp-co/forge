import type { InboundRefusalCode } from '@forge/contracts/integrations';
import { type Said, say, verbatim } from '@forge/contracts/said';
import type { BindingRole } from '../../db/schema.js';
import {
  type AdapterContext,
  applyClaimedInbound,
  declareIntegration,
  type HealthCheckResult,
  healthOf,
  type InboundDispatchInput,
  type InboundDispatchResult,
  type InboundFact,
  type IntegrationAdapterMethods,
  recordRefusedInbound,
  refusedInbound,
  thrownSaid,
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
): Promise<{ fault: Said | null; url: string | null }> {
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
    // the hook reader's own sentence, carried as it wrote it
    return { fault: verbatim(hook.reason), url: null };
  }
  await updateConnection(connectionId, {
    inboundEndpointObserved: { url: hook.url, active: hook.active, observedAt },
  });
  if (hook.url === null || hook.url === '') {
    return {
      fault: say('integrations.health.github.noWebhook', { repository: args.repository }),
      url: null,
    };
  }
  if (hook.active === false) {
    return {
      fault: say('integrations.health.github.webhookOff', {
        repository: args.repository,
        url: hook.url,
      }),
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
): Promise<{ body: { full_name?: string; default_branch?: string } } | { refused: Said }> {
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
        refused: say('integrations.health.github.notPermitted', { repository: `${owner}/${repo}` }),
      };
    }
    if (status === 404) {
      return {
        refused: say('integrations.health.github.notAmong', { repository: `${owner}/${repo}` }),
      };
    }
    return { refused: say('integrations.health.github.http', { status: String(status) }) };
  }
}

/**
 * What the installation is not allowed to do that Forge's code asks of it (ISS-1153): an App
 * granted less answered every probe above and reported `ok` while it could not merge. It is
 * collected beside the webhook fault rather than returned first, so one probe names both.
 */
async function grantShortfall(
  args: Parameters<typeof checkInstallationGrant>[0],
): Promise<Said | null> {
  const grant = await checkInstallationGrant(args);
  // the grant reader's own sentences, carried as it wrote them
  const said =
    grant.kind === 'unread' ? grant.reason : grant.kind === 'short' ? grant.message : null;
  return said === null ? null : verbatim(said);
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
    const finish = async (status: HealthCheckResult['status'], says?: Said) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthDetail: says ?? null,
        lastHealthAt: new Date(),
      });
      return healthOf(status, says);
    };
    if (!appId || !privateKey)
      return finish('error', say('integrations.health.github.noCredential'));
    if (!installationId) return finish('error', say('integrations.health.github.notInstalled'));
    if (!owner || !repo) return finish('error', say('integrations.health.github.noRepo'));

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
        (f): f is Said => f !== null,
      );
      const [first, second] = faults;
      if (first) {
        return finish(
          'degraded',
          second ? say('integrations.health.both', { first, second }) : first,
        );
      }
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
        return finish(err.status === 401 ? 'needs_reauth' : 'error', verbatim(err.message));
      }
      return finish('error', thrownSaid(err));
    }
  },

  async handleInbound(
    ctx: AdapterContext<GitHubConfig, GitHubSecrets>,
    input: InboundDispatchInput,
  ): Promise<InboundDispatchResult> {
    const eventType = input.headers['x-github-event'];
    const payload = input.payload as GitHubEventPayload & {
      repository?: { full_name?: string };
    };
    const guid = input.headers['x-github-delivery'];
    // A verified delivery that cannot be applied is a recorded refusal, never a throw the door
    // answers 500 with and no row remembers.
    const refuseRecorded = async (
      code: InboundRefusalCode,
      detail: string,
      path: string,
    ): Promise<never> => {
      const deliveryId = await recordRefusedInbound({
        bindingId: ctx.bindingId,
        eventName: `${eventType ?? 'unknown'}.${payload?.action ?? 'unknown'}`,
        payload,
        requestId: guid,
        code,
        detail,
      });
      throw refusedInbound(code, detail, deliveryId, path);
    };
    if (!eventType) {
      return refuseRecorded(
        'WEBHOOK_EVENT_MISSING',
        'github webhook: the x-github-event header is missing, so there is no event to apply',
        '',
      );
    }

    const arrived = payload?.repository?.full_name;
    const expected =
      ctx.config?.owner && ctx.config?.repo ? `${ctx.config.owner}/${ctx.config.repo}` : null;
    if (arrived && expected && arrived.toLowerCase() !== expected.toLowerCase()) {
      return refuseRecorded(
        'WEBHOOK_FOREIGN_REPOSITORY',
        `github webhook: delivery is for ${arrived}, this binding is ${expected}`,
        '/repository/full_name',
      );
    }
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
      (tx) => input.emitFacts(tx, facts),
    );
    return { deliveryId, actions: (result?.actions ?? 0) + facts.length };
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
  presentation: {
    label: 'GitHub',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail: say('integrations.detail.neverGithub'),
    cardMeta: (config) => ({
      host: githubHostOf(config),
      ...(typeof config.owner === 'string' && typeof config.repo === 'string'
        ? { repositoryPath: `${config.owner}/${config.repo}` }
        : {}),
    }),
  },
  adapter: githubAdapterMethods,
  sourceHost: githubSourceHost,
  gitCredential: githubGitCredential,
});
