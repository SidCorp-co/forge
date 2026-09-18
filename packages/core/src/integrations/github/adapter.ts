/**
 * GitHub integration adapter — the inbound half of the provider, and since
 * ISS-1072 one outbound verb.
 *
 * Replaces the second webhook path that used to live inside `POST /in/:slug`,
 * keyed on `projects.webhookSecret`: one shared secret per project, no
 * environment split, no delivery log, no health, no breaker. Measured on the
 * live fleet 2026-09-06, that path had 0 of 41 projects configured and had
 * produced 0 of 4,436 issues, so there was nothing in the field to keep
 * working.
 *
 * Outbound is a TABLE of verbs, and today it holds two: publishing
 * `forge/issue-contract` on a pull request's head (ISS-1072), and merging a
 * pull request (ISS-1073). `canDispatch` turned true in the change that
 * implemented the first and not before, which is the rule ISS-1062 wrote and
 * `check-integration-declarations.mjs` holds the adapter to.
 *
 * The two arrived in that order on purpose: a check run cannot damage a
 * repository and a merge can, so the projection was proved under real load by a
 * face that could not hurt anything before the kernel was given power to merge
 * on it. Opening a pull request and reviewing one are still not here — they need
 * judgement, so they are `agent-ops.ts`'s — and a name this table does not hold
 * is refused against the table rather than growing a branch that does the
 * nearest thing.
 */

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
// cm:edge lockstep -> packages/core/src/integrations/github/contract-check.ts, packages/core/src/integrations/github/merge.ts — each entry is that module's own exported event name, read rather than restated so a rename there cannot leave a verb this adapter claims to serve and does not
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

  // cm:guard the event name is matched against the TABLE and anything else is refused naming every verb the table holds. A default arm that did the nearest thing would make a caller's mistake return 200 and look like it worked, which is the wrong-input-absorbed shape CLAUDE.md refuses; the refusal IS the deliverable here. The table is also the extension point: a verb is added by putting it in `SERVED_VERBS`, and the refusal picks it up without being edited.
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

    // cm:guard the binding is re-read at dispatch, exactly as `coolify/adapter.ts` re-reads its connection: the context was built earlier and a binding deactivated since is a repository nobody is bound to any more. The refusal is RECORDED as well as thrown, because ISS-1072 requires a project with no active binding to be named in the delivery log — and it is recorded against a null binding rather than the dead one, since a row scoped to a binding that is gone is a row nothing will list.
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

    // cm:guard the binding the context authorised is carried INTO both verbs. Without it the
    // caller's authorisation and the repository written to are resolved independently, and a
    // dispatch for one project's binding could publish — or MERGE — on another's.
    if (input.eventName === MERGE_EVENT) {
      const requestedBy = typeof payload.requestedBy === 'string' ? payload.requestedBy : '';
      const merged = await mergeStoredPullRequest(
        {
          pullRequestId,
          requestedBy,
          runId: input.runId ?? null,
          ...(typeof payload.expectedHeadSha === 'string'
            ? { expectedHeadSha: payload.expectedHeadSha }
            : {}),
          ...(isMergeMethod(payload.method) ? { method: payload.method } : {}),
        },
        ctx.bindingId,
      );
      if (!merged) {
        throw new Error(
          `github: no stored pull request ${pullRequestId} — nothing on this project's projection has that id`,
        );
      }
      // cm:guard a REFUSED merge throws rather than returning a result, and that is the difference from the check publish beside it. A skipped publish is Forge deciding not to write; a refused merge is a caller's merge that did not happen, and returning it as a dispatch RESULT would let a worker mark the job done. The delivery row carries the sentence either way.
      if (merged.kind === 'refused') throw new Error(merged.detail);
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
    // cm:guard `core-mediated` and NOT `direct-mcp`, and the difference is the whole of ISS-1071's rule 2: `direct-mcp` renders the credential into a runner box's MCP config and puts Forge outside the call path. This App's private key is the identity every write to the repository is made under — it can open, comment and review on every repository the installation covers — so there is no version of handing it to a box that is worth the round trip it saves. Core holds it, core makes the call, and `forge_github` is where an agent asks.
    // cm:guard `forge_github` is the WHOLE list on purpose. A verb that merges is not missing from it, it is refused by it: merging is a kernel transition on THIS face, where the same operation stamps `merged_at` (ISS-1073, `merge.ts`). `agent-ops.ts:kernelVerbRefusal` is the sentence a caller naming one gets.
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
