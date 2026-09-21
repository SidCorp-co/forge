import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type BindingRole, integrationBindings } from '../../db/schema.js';
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
  NonRetryableDispatchError,
  type OutboundDispatchInput,
  type OutboundDispatchResult,
} from '../types.js';
import { GitHubAuthError, installationToken } from './app-auth.js';
import { githubInboundSecret, syncRepoUrlFromGitHubBinding } from './bind-effects.js';
import { CHECK_PUBLISH_EVENT, publishForStoredPullRequest } from './contract-check.js';
import { MERGE_EVENT, MERGE_METHODS, type MergeMethod, mergeStoredPullRequest } from './merge.js';
import { GITHUB_BINDING_CONFIG_KEYS, githubConfigBase, githubSecretsSchema } from './schemas.js';
import { GITHUB_API_BASE, type GitHubConfig, type GitHubSecrets } from './types.js';

const PROBE_TIMEOUT_MS = 8000;

/**
 * The merge payload, or the sentence saying what is wrong with it.
 *
 * An ABSENT optional field and a PRESENT invalid one are different things and are
 * answered differently: the first takes the default, the second is refused by
 * name. Merging is kernel input, where `VISION: kernel-hard-policy-soft` allows
 * no normalisation at all — a `method: "sqaush"` quietly read as `merge` is a
 * merge commit on a repository whose owner asked for a squash, arrived at by a
 * typo nobody was told about.
 */
function readMergePayload(
  payload: Record<string, unknown>,
): { requestedBy: string; expectedHeadSha?: string; method?: MergeMethod } | { refusal: string } {
  const requestedBy = typeof payload.requestedBy === 'string' ? payload.requestedBy : '';
  const out: { requestedBy: string; expectedHeadSha?: string; method?: MergeMethod } = {
    requestedBy,
  };
  if (payload.expectedHeadSha !== undefined) {
    if (
      typeof payload.expectedHeadSha !== 'string' ||
      !/^[0-9a-f]{7,64}$/i.test(payload.expectedHeadSha)
    ) {
      return {
        refusal: `github: \`expectedHeadSha\` must be a git sha — 7 to 64 hex characters — and this call sent ${JSON.stringify(payload.expectedHeadSha)}. It is the head the merge is conditional on, so it is refused rather than dropped.`,
      };
    }
    out.expectedHeadSha = payload.expectedHeadSha;
  }
  if (payload.method !== undefined) {
    if (!isMergeMethod(payload.method)) {
      return {
        refusal: `github: \`${String(payload.method)}\` is not a merge method — GitHub has ${MERGE_METHODS.map((m) => `\`${m}\``).join(', ')}. It is refused rather than defaulted, because a mistyped method lands a different shape of history on the base branch.`,
      };
    }
    out.method = payload.method;
  }
  return out;
}

/** A merge method GitHub has, refused by name rather than defaulted from anything else. */
function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === 'string' && (MERGE_METHODS as readonly string[]).includes(value);
}

/**
 * Every outbound verb this adapter serves, in the order they were implemented.
 *
 * One array rather than a switch with a `default` that throws, because the
 * refusal has to NAME the legal set and a switch cannot be asked what its own
 * cases are. Adding a verb here and a branch below is one edit; the sentence a
 * caller gets for a name that is not on it needs no edit at all.
 */
const SERVED_VERBS = [CHECK_PUBLISH_EVENT, MERGE_EVENT] as const;

function isServedVerb(name: string): name is (typeof SERVED_VERBS)[number] {
  return (SERVED_VERBS as readonly string[]).includes(name);
}

const githubAdapterMethods: IntegrationAdapterMethods<GitHubConfig, GitHubSecrets> = {
  inboundSecret: (connection) => githubInboundSecret(connection as IntegrationConnectionRow),
  onBindingCreated: async ({ projectId, role, config }) => ({
    repoUrl: await syncRepoUrlFromGitHubBinding({
      projectId,
      role: role as BindingRole,
      config: config as GitHubConfig,
    }),
  }),

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

  async dispatchOutbound(
    ctx: AdapterContext<GitHubConfig, GitHubSecrets>,
    input: OutboundDispatchInput,
  ): Promise<OutboundDispatchResult> {
    const startedAt = Date.now();
    if (!isServedVerb(input.eventName)) {
      throw new Error(
        `github: no outbound verb named \`${input.eventName}\` — this adapter serves ${SERVED_VERBS.map((v) => `\`${v}\``).join(', ')} and nothing else. Opening a pull request and reviewing one need judgement and are \`forge_github\`'s.`,
      );
    }

    const [live] = await db
      .select({ id: integrationBindings.id })
      .from(integrationBindings)
      .where(and(eq(integrationBindings.id, ctx.bindingId), eq(integrationBindings.active, true)))
      .limit(1);
    if (!live) {
      const message = `github: project ${ctx.projectId} has no active GitHub binding — binding ${ctx.bindingId} is gone or deactivated, so there is no repository to publish a contract check on`;
      await recordDelivery({
        bindingId: null,
        direction: 'outbound',
        eventName: input.eventName,
        payload: { projectId: ctx.projectId, bindingId: ctx.bindingId, refused: message },
        status: 'failed',
      });
      throw new Error(message);
    }

    const payload = (input.payload ?? {}) as Record<string, unknown>;
    const pullRequestId = typeof payload.pullRequestId === 'string' ? payload.pullRequestId : null;
    if (!pullRequestId) {
      throw new Error(
        `github: \`${input.eventName}\` needs a payload of the shape { pullRequestId: "<uuid of a repo_pull_requests row>" }`,
      );
    }

    if (input.eventName === MERGE_EVENT) {
      const read = readMergePayload(payload);
      if ('refusal' in read) throw new Error(read.refusal);
      const merged = await mergeStoredPullRequest(
        { pullRequestId, runId: input.runId ?? null, ...read },
        ctx.bindingId,
      );
      if (!merged) {
        throw new Error(
          `github: no stored pull request ${pullRequestId} — nothing on this project's projection has that id`,
        );
      }
      if (merged.kind === 'refused') {
        throw new NonRetryableDispatchError(merged.detail, merged.reason);
      }
      return {
        deliveryId: merged.deliveryId,
        durationMs: Date.now() - startedAt,
        externalId: merged.commitSha,
      };
    }

    const outcome = await publishForStoredPullRequest(pullRequestId, ctx.bindingId);
    if (!outcome) {
      throw new Error(
        `github: no stored pull request ${pullRequestId} — nothing on this project's projection has that id`,
      );
    }
    return {
      deliveryId: outcome.deliveryId,
      durationMs: Date.now() - startedAt,
      ...(outcome.kind === 'published' ? { externalId: String(outcome.checkRunId) } : {}),
    };
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
    canDispatch: true,
    canReceiveWebhook: true,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: true,
    multiBinding: false,
    webhookHeader: 'x-github-event',
    webhookSignatureHeader: 'x-hub-signature-256',
    structuredRollback: false,
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
  usage: {
    hint: "Read and write this repository through `forge_github` — a pull request diff, a failing check run's log, a comment, a new pull request, a review request, a review verdict. Never `gh`: the App is the identity, and no credential reaches this box. Nothing here merges.",
  },
  presentation: null,
  adapter: githubAdapterMethods,
});

export const githubAdapter = githubAdapterMethods;
