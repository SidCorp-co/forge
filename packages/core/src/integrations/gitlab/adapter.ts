import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  type AdapterContext,
  declareIntegration,
  type HealthCheckResult,
  type InboundDispatchInput,
  type InboundDispatchResult,
  type InboundFact,
  type IntegrationAdapterMethods,
  inboundWebhookUrl,
  isPreviousCredentialValid,
  recordDelivery,
  resolveApiBaseUrl,
  updateConnection,
  updateDelivery,
} from '../index.js';
import { sourceHostMismatch } from '../source-host/index.js';
import { gitlabGitCredential } from './git-credential.js';
import { GITLAB_BINDING_CONFIG_KEYS, gitlabConfigBase, gitlabSecretsSchema } from './schemas.js';
import { gitlabSourceHost } from './source-host.js';
import {
  GITLAB_DEFAULT_BASE_URL,
  type GitLabConfig,
  type GitLabSecrets,
  gitlabHostOf,
} from './types.js';
import { handleGitLabEvent } from './webhook.js';

const PROBE_TIMEOUT_MS = 10_000;

/** The events a GitLab hook must send for Forge to see the lifecycle, by GitLab's own field names. */
const NEEDED_HOOK_EVENTS = ['push_events', 'merge_requests_events', 'pipeline_events'] as const;

interface HookBody {
  url?: string;
  push_events?: boolean;
  merge_requests_events?: boolean;
  pipeline_events?: boolean;
}

type Probe = { ok: true; body: unknown } | { ok: false; status: number };

async function probe(base: string, path: string, token: string): Promise<Probe> {
  const res = await fetch(`${base}/api/v4${path}`, {
    headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

async function expectedHookUrl(projectId: string): Promise<string | null> {
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const apiBase = resolveApiBaseUrl();
  return apiBase && project?.slug ? inboundWebhookUrl(apiBase, project.slug) : null;
}

/**
 * Where the project's GitLab hooks call, stored as the answer and judged per binding at read time.
 * The observation is the connection's column; a project access token reaches one project, which is
 * the connection shape this integration is built for.
 */
async function observeHooks(
  ctx: AdapterContext<GitLabConfig, GitLabSecrets>,
  base: string,
  path: string,
  token: string,
): Promise<string | null> {
  const observedAt = new Date().toISOString();
  const hooks = await probe(base, `${path}/hooks`, token);
  if (!hooks.ok) {
    const readError = `GitLab answered HTTP ${hooks.status} listing the project's webhooks — reading them takes the Maintainer role`;
    await updateConnection(ctx.connectionId, {
      inboundEndpointObserved: { url: null, active: null, observedAt, readError },
    });
    return readError;
  }
  const list = Array.isArray(hooks.body) ? (hooks.body as HookBody[]) : [];
  const expected = await expectedHookUrl(ctx.projectId);
  const hook = list.find((h) => expected !== null && h.url === expected) ?? list[0] ?? null;
  await updateConnection(ctx.connectionId, {
    inboundEndpointObserved: { url: hook?.url ?? null, active: hook ? true : null, observedAt },
  });
  if (!hook) {
    return `the GitLab project holds no webhook, so GitLab will never call in — add one at ${expected ?? "this core's /api/webhooks/in/<project slug>"} with the binding's secret token`;
  }
  const missing = NEEDED_HOOK_EVENTS.filter((e) => hook[e] !== true);
  return missing.length > 0
    ? `the GitLab webhook at ${hook.url} does not send ${missing.join(', ')}, so Forge cannot see every push, merge request and pipeline — tick them on the hook`
    : null;
}

const gitlabAdapterMethods: IntegrationAdapterMethods<GitLabConfig, GitLabSecrets> = {
  verifyBindingTarget: ({ projectId, connection, config }) =>
    sourceHostMismatch({
      projectId,
      provider: 'gitlab',
      host: gitlabHostOf({ ...((connection.config ?? {}) as Record<string, unknown>), ...config }),
    }),

  async healthcheck(ctx): Promise<HealthCheckResult> {
    const finish = async (
      status: HealthCheckResult['status'],
      message?: string,
      diagnostics?: Record<string, unknown>,
    ) => {
      await updateConnection(ctx.connectionId, {
        lastHealthStatus: status,
        lastHealthDetail: message ?? null,
        lastHealthAt: new Date(),
      });
      return {
        status,
        ...(message === undefined ? {} : { message }),
        ...(diagnostics ? { diagnostics } : {}),
      };
    };
    const base = (ctx.config?.baseUrl ?? GITLAB_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const primary = ctx.secrets?.token;
    if (!primary) return finish('error', 'this connection holds no GitLab access token');
    const { projectPath, projectId } = ctx.config ?? {};
    const path = projectPath
      ? `/projects/${encodeURIComponent(projectPath)}`
      : projectId
        ? `/projects/${projectId}`
        : '/user';

    try {
      let token = primary;
      let read = await probe(base, path, token);
      const previous = ctx.secrets?.previousToken;
      if (!read.ok && read.status === 401 && previous && isPreviousCredentialValid(ctx.secrets)) {
        token = previous;
        read = await probe(base, path, token);
      }
      if (!read.ok) {
        if (read.status === 401)
          return finish(
            'needs_reauth',
            `GitLab does not recognise this token (HTTP 401 on ${path})`,
          );
        if (read.status === 403) {
          return finish(
            'needs_scope',
            `GitLab recognises this token and refuses ${path} (HTTP 403) — it needs the \`api\` scope and at least Developer on the project`,
          );
        }
        if (read.status === 404) {
          return finish(
            'error',
            `${projectPath ?? projectId} is not a project this token can see on ${base} (HTTP 404)`,
          );
        }
        return finish('error', `GitLab returned HTTP ${read.status} for ${path}`);
      }
      if (path === '/user') {
        const user = read.body as { username?: string };
        return finish(
          'error',
          `the token is valid (as ${user.username ?? 'an unnamed user'}) and this binding names no GitLab project`,
        );
      }
      const project = read.body as { path_with_namespace?: string; default_branch?: string };
      const fault = await observeHooks(ctx, base, path, token);
      const diagnostics = {
        repository: project.path_with_namespace,
        defaultBranch: project.default_branch,
      };
      if (fault) return finish('degraded', fault, diagnostics);
      return finish('ok', undefined, diagnostics);
    } catch (err) {
      return finish('error', err instanceof Error ? err.message : String(err));
    }
  },

  async handleInbound(ctx, input: InboundDispatchInput): Promise<InboundDispatchResult> {
    const eventType = input.headers['x-gitlab-event'];
    if (!eventType) throw new Error('gitlab webhook: x-gitlab-event missing');
    const payload = (input.payload ?? {}) as {
      project?: { path_with_namespace?: string; id?: number };
    };
    const arrived = payload.project?.path_with_namespace;
    const expected = ctx.config?.projectPath;
    if (arrived && expected && arrived.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`gitlab webhook: delivery is for ${arrived}, this binding is ${expected}`);
    }
    const uuid = input.headers['x-gitlab-event-uuid'] ?? input.headers['x-gitlab-webhook-uuid'];
    const logged = {
      bindingId: ctx.bindingId,
      direction: 'inbound' as const,
      eventName: eventType,
      payload,
      ...(uuid ? { requestId: uuid } : {}),
    };
    const facts: InboundFact[] = [];
    let result: Awaited<ReturnType<typeof handleGitLabEvent>>;
    try {
      result = await handleGitLabEvent(
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
      const failedId = await recordDelivery({ ...logged, status: 'failed' });
      await updateDelivery(failedId, {
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const deliveryId = await recordDelivery({
      ...logged,
      status: result.refusal ? 'failed' : 'ok',
    });
    if (result.refusal) await updateDelivery(deliveryId, { errorMessage: result.refusal });
    return {
      deliveryId,
      actions: result.actions,
      ...(result.refusal ? { refusal: result.refusal } : {}),
      facts,
    };
  },
};

/**
 * GitLab's declaration (ISS-50): a GitLab project as the source host a project's whole lifecycle
 * runs on — change requests, merges, the push that lands them, the pipeline that gates them — and
 * the token a runner's git credential helper is served for it.
 */
export const gitlabIntegration = declareIntegration<GitLabConfig, GitLabSecrets>({
  provider: 'gitlab',
  capabilities: {
    // Merging is `POST /api/issues/:id/merge-pull-request` (`source-host/merge.ts`), never an
    // outbound verb, so nothing dispatches through this adapter.
    canDispatch: false,
    canReceiveWebhook: true,
    // A GitLab project hook calls on every push, merge request and pipeline: a live binding that has
    // recorded nothing is a pipe that is not carrying.
    inboundUnprompted: true,
    canDeploy: false,
    liveConfirmGate: false,
    hasDeliveryLog: true,
    multiBinding: false,
    webhookHeader: 'x-gitlab-event',
    webhookSignatureHeader: 'x-gitlab-token',
    webhookVerification: 'shared-token',
    structuredRollback: false,
    agentPath: { kind: 'core-mediated', tools: ['forge_source'] },
  },
  schemas: {
    connectionConfig: gitlabConfigBase,
    connectionPatchConfig: gitlabConfigBase.partial(),
    bindingConfig: gitlabConfigBase,
    patchConfig: gitlabConfigBase.partial(),
    secrets: gitlabSecretsSchema,
    patchSecrets: gitlabSecretsSchema.partial(),
    primaryCredentialField: 'token',
    previousCredentialField: 'previousToken',
    independentSecretFields: [],
    bindingConfigKeys: GITLAB_BINDING_CONFIG_KEYS,
  },
  usage: {
    hint: "Read and write merge requests through `forge_source` — a diff, a failing job's trace, a note, a new merge request, reviewers, an approval. Never `glab`: Forge holds the token. Nothing there merges.",
  },
  presentation: {
    label: 'GitLab',
    alwaysEnvironmentKeyed: false,
    neverCheckedDetail:
      'Never checked — run Test connection to probe the token and the project webhook.',
    cardMeta: (config) => ({
      host: gitlabHostOf(config),
      ...(typeof config.projectPath === 'string' ? { projectPath: config.projectPath } : {}),
    }),
  },
  adapter: gitlabAdapterMethods,
  sourceHost: gitlabSourceHost,
  gitCredential: gitlabGitCredential,
});
