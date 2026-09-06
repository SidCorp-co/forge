/**
 * ISS-242 — Action-dispatcher MCP tool `forge_coolify_deploy` that the stock
 * pipeline skills (forge-release / forge-staging / forge-code / forge-fix /
 * forge-test) already call but which had no server-side implementation,
 * causing a tool-not-found at the deploy step.
 *
 * The action list and what each one returns live in the tool `description`
 * below — it is what a model actually reads, and a second copy here is a copy
 * that goes stale. ISS-925 added the controls beside deploy: `cancel`,
 * `rollback-images`, `rollback`, `applications`, `targets`.
 *
 * Authorization is membership-level (`assertPrincipalIsMember`) like
 * `forge_issues`, raised to writer for the three actions that change something;
 * prod safety is the human-confirm gate inside `tryDispatchCoolifyRelease` and
 * `prodActionNeedsHumanConfirm`, not RBAC. No DEVICE_REQUIRED entry — the tool
 * has no runner dependency.
 */

import { z } from 'zod';
import { CoolifyApiError } from '../../integrations/coolify/client.js';
import {
  activeCoolifyIntegrations,
  CoolifyCommandError,
  coolifyDeliveryStatus,
  listCoolifyIntegrations,
  resolveIntegrationRow,
  runCoolifyDeploy,
} from '../../integrations/coolify/commands.js';
import {
  listApplicationsForIntegration,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  runCoolifyCancel,
  runCoolifyRollback,
} from '../../integrations/coolify/controls.js';
import {
  fetchCoolifyDeploymentLogs,
  fetchCoolifyRuntimeLogs,
} from '../../integrations/coolify/log-fetch.js';
import type { CoolifyConfig } from '../../integrations/coolify/types.js';
import { findLastOutbound } from '../../integrations/deliveries.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'deploy',
      'status',
      'logs',
      'runtime-logs',
      'cancel',
      'rollback-images',
      'rollback',
      'applications',
      'targets',
    ]),
    projectId: z.uuid().optional(),
    issueId: z.uuid().optional(),
    /** ISS-764 — batch release path: deploy via an existing pipeline run that
     *  has no associated issue. Mutually exclusive with issueId. When set,
     *  dispatches prod (allowProd=true) through the shared release path. */
    pipelineRunId: z.uuid().optional(),
    integrationId: z.uuid().optional(),
    deploymentUuid: z.string().optional(),
    /** runtime-logs / rollback-images / rollback: the Coolify application
     *  (target) resourceUuid; defaults to the integration's sole target. */
    resourceUuid: z.string().optional(),
    /** rollback: the IMAGE TAG to roll back to, exactly as `rollback-images`
     *  lists it. A tag Coolify no longer lists is refused by name. */
    commit: z.string().optional(),
    /** logs + runtime-logs: number of recent lines to keep. REJECTED outside
     *  1..1000, not clamped into it — a description that says "clamped" of a
     *  bound that hard-fails is the same lie ISS-787 removed from `lines`
     *  itself. Coerced: MCP transports routinely deliver numbers as strings. */
    lines: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

async function resolveProjectId(input: Input, ctx: McpContext): Promise<string> {
  return resolveEffectiveProjectId(ctx, input.projectId);
}

export const forgeCoolifyDeployTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_coolify_deploy',
  description:
    'Coolify deploy controls for the pipeline skills. Actions: list | deploy | status | logs | ' +
    'runtime-logs | cancel | rollback-images | rollback | applications | targets. ' +
    'MODEL: one integration = one project+ENVIRONMENT binding (staging vs prod are SEPARATE ' +
    'integrations). Each integration deploys ONE OR MORE targets[] — each target is its own Coolify ' +
    'application (e.g. a split backend + frontend, or a worker), deployed TOGETHER. A single deploy ' +
    'FANS OUT to every target of the integration (one Coolify build per target); the pipeline run is ' +
    'marked done only when EVERY target webhook reports success, and FAILS on the first target ' +
    'failure. So if an app (e.g. the backend) is not deploying, check it is CONFIGURED as a target on ' +
    'that integration (project settings → Integrations) — Forge only deploys the targets the ' +
    'integration holds. ' +
    'list: active Coolify integrations for the project (id, environment, targets[]={id,label,' +
    'resourceUuid}, lastHealthStatus, breakerOpen); empty array => project is local-only (no Coolify). ' +
    'Inspect targets[] to confirm every app you expect (BE+FE) is present. ' +
    'deploy: issueId is OPTIONAL; dispatches ALL targets of the resolved integration. With issueId — ' +
    "run-tracked deploy: resolves the issue's latest pipeline run and enqueues via the SAME path as " +
    'the release auto-subscriber (each target webhook then advances that run; run completes when all ' +
    'targets succeed). When issueId is combined with integrationId, integrationId is a HARD scope ' +
    'filter — ONLY that binding dispatches, even if other bindings (e.g. prod) exist on the run. ' +
    'When issueId is given WITHOUT integrationId, prod-environment bindings are dispatched ONLY when ' +
    'the issue has reached the release stage (status released/closed) — every pre-release call ' +
    '(code/fix/testing) is staging-only and NEVER touches a prod binding, regardless of ' +
    'pipelineConfig.autoProdDeploy (that flag only bypasses the gate for the release-triggered ' +
    'auto-subscriber, not for this tool pre-release). With pipelineRunId (no issueId) — ISS-764 ' +
    'batch release path: the run is already open (kind=system); dispatches ALL targets prod-allowed ' +
    '(allowProd=true) via the shared release path. Prod human-confirm gate still applies — ' +
    'pendingHumanConfirm:true means abort the batch. Mutually exclusive with issueId. ' +
    'Without issueId or pipelineRunId — run-less resource redeploy: ' +
    'resolves the target integration like the logs action (explicit integrationId, else the single ' +
    'active Coolify integration, else BAD_REQUEST when multiple exist) and dispatches with no run ' +
    'attached (webhooks record deliveries but advance no pipeline). Each call is its own dispatch ' +
    '(per-attempt requestId, suffixed per target) and Coolify force-rebuilds, so re-deploying after a ' +
    'branch fix fires fresh builds. At the release stage, prod integrations still honor the ' +
    'human-confirm gate (unless the project sets pipelineConfig.autoProdDeploy): returns ' +
    'pendingHumanConfirm:true and does NOT dispatch until confirmed via the confirm-prod-deploy ' +
    'endpoint. ' +
    'status: latest outbound delivery PER TARGET for the integration(s) (or a specific integrationId): ' +
    'deploymentUuid, status, breakerOpen, createdAt — expect one row per target. ' +
    'logs: fetch the Coolify build/deploy log for a deployment and return it scrubbed + tailed. ' +
    'Resolves deploymentUuid from the explicit deploymentUuid param, else the most recent outbound ' +
    'delivery (across the integration targets) — pass deploymentUuid to target a specific app/target. ' +
    'Requires integrationId when multiple active Coolify integrations exist. ' +
    'Secrets (Authorization/Cookie/X-Api-Key headers, token/apiKey/password/jwt fields, tokenized ' +
    "URLs, and the integration's own apiToken) are redacted line-by-line; build-stage stderr is " +
    'preserved. Returns { integrationId, deploymentUuid, status, commit, logs, truncated, fetchedAt, logsDigest }. `commit` is the git SHA this deployment built, read from the deployment record — the log line `SOURCE_COMMIT=` is redacted with the rest of the env dump, so compare THIS field against your merge SHA to prove the change is live. On a Coolify API ' +
    'error returns { error, httpStatus } with no raw body. Tailed to the last `lines` ' +
    '(default 100) / ~16KB, truncated:true when cut. `lines` outside 1..1000 is REJECTED, not ' +
    'clamped — a value of 5000 is a validation error, not a 1000-line tail. ' +
    'A build log that has not moved is INDISTINGUISHABLE from a stale snapshot by eye, so compare ' +
    '`logsDigest` across calls: identical digest + advancing `fetchedAt` means Coolify really is ' +
    'returning the same bytes, not that this tool cached them. Neither proves the build is hung — ' +
    'read `status` for that. ' +
    'runtime-logs: tail the LIVE application container log (NOT the build log) via Coolify ' +
    'applications/{uuid}/logs. Resolves the target from resourceUuid (else the integration sole ' +
    'target; multiple targets => pass resourceUuid, see list); optional `lines` (default 100, ' +
    'rejected outside 1..1000). ' +
    'Same scrubbing/tailing, `fetchedAt` and `logsDigest` as logs. CAVEAT: for a docker-compose application Coolify returns only ONE ' +
    "container's logs and its public API has NO working per-service selector — reliable for " +
    'single-container apps; a compose deploy cannot be narrowed to a specific service here. Returns ' +
    '{ integrationId, resourceUuid, logs, truncated, fetchedAt, logsDigest } or { error, httpStatus }. ' +
    'cancel: stop a deployment that is still queued or building — POST deployments/{uuid}/cancel. ' +
    "Resolves deploymentUuid from the explicit param, else the integration's most recent outbound " +
    'delivery. Coolify answers 400 for a deployment that has already finished and that message is ' +
    'returned as-is; nothing is reported cancelled that was not. The cancel is recorded as an ' +
    'outbound delivery and the in-flight confirmation poll settles the run on cancelled-by-user. ' +
    'rollback-images: what this target can actually be rolled back to — { current, images[]={tag,' +
    'createdAt,isCurrent} }. READ THIS FIRST; an empty images[] also means Coolify could not reach ' +
    "the application's server, so it is a refusal, not an empty shelf. " +
    'rollback: queue a rollback of one target to `commit` (the IMAGE TAG from rollback-images, not ' +
    'a git SHA). A tag Coolify does not list is REFUSED BY NAME and is never resolved to the ' +
    'nearest image. Returns { performed, deploymentUuid }; the rollback build is polled and audited ' +
    'exactly like a deploy. ' +
    'cancel and rollback answer to the SAME production gate a deploy does: against a prod binding ' +
    'both return pendingHumanConfirm:true and do nothing unless the project set ' +
    'pipelineConfig.autoProdDeploy. ' +
    'applications: every Coolify application this credential can see — { uuid, name, fqdn, ' +
    'gitRepository, gitBranch, gitCommitSha, status }. The pick-list that replaces transcribing a ' +
    'resourceUuid. ' +
    'targets: the bound targets of one integration resolved against that list, each with its ' +
    'Coolify identity and `found:false` when Coolify does not list the bound uuid — which is how a ' +
    'wrong binding is visible without opening Coolify. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    try {
      return await dispatchAction(input, ctx, principal);
    } catch (err) {
      // cm:edge contract -> packages/core/src/integrations/coolify/commands.ts — that module throws `CoolifyCommandError` with a bare sentence because REST turns it into a 400 body; the MCP contract is a `CODE: message` string, so the prefix is added HERE and must not be baked into the shared message.
      if (err instanceof CoolifyCommandError) throw new Error(`BAD_REQUEST: ${err.message}`);
      throw err;
    }
  },
});

async function dispatchAction(
  input: z.infer<typeof inputSchema>,
  ctx: McpContext,
  principal: McpContext['principal'],
): Promise<unknown> {
  const control = await dispatchControlAction(input, ctx, principal);
  if (control !== NOT_A_CONTROL_ACTION) return control;
  switch (input.action) {
    case 'list': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);
      return listCoolifyIntegrations(projectId);
    }

    case 'deploy': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsWriter(principal, projectId);
      return runCoolifyDeploy({
        projectId,
        ...(input.issueId ? { issueId: input.issueId } : {}),
        ...(input.pipelineRunId ? { pipelineRunId: input.pipelineRunId } : {}),
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
      });
    }

    case 'status': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);
      return coolifyDeliveryStatus({
        projectId,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
      });
    }

    case 'logs': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);

      // Resolve the integration row. Explicit integrationId wins; otherwise
      // require exactly one active Coolify integration (multiple is ambiguous).
      const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
      if (!row) {
        return {
          integrationId: null,
          deploymentUuid: null,
          logs: null,
          reason: 'no-integration',
        };
      }

      // Resolve the deploymentUuid: explicit param, else the integration's
      // last outbound delivery (its Coolify response carries deployment_uuid).
      let deploymentUuid = input.deploymentUuid ?? null;
      if (!deploymentUuid) {
        const last = await findLastOutbound(row.id);
        const response = (last?.response ?? null) as { deployment_uuid?: string } | null;
        deploymentUuid = response?.deployment_uuid ?? null;
      }
      if (!deploymentUuid) {
        return {
          integrationId: row.id,
          deploymentUuid: null,
          logs: null,
          reason: 'no-deployment',
        };
      }

      try {
        const result = await fetchCoolifyDeploymentLogs(row.pair, deploymentUuid, input.lines);
        return { integrationId: row.id, ...result };
      } catch (err) {
        // Surface a clear message; NEVER echo the raw Coolify body (may leak).
        if (err instanceof CoolifyApiError) {
          return {
            integrationId: row.id,
            deploymentUuid,
            logs: null,
            error: 'coolify API error',
            httpStatus: err.status,
          };
        }
        throw err;
      }
    }

    case 'runtime-logs': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);

      const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
      if (!row) {
        return { integrationId: null, resourceUuid: null, logs: null, reason: 'no-integration' };
      }

      // Resolve the target application to tail: explicit resourceUuid wins;
      // else the integration's sole target. Multiple targets is ambiguous —
      // require the caller to name one (and the compose caveat means even the
      // named target may only expose a single container's logs).
      const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
      const resourceUuid =
        input.resourceUuid ?? (targets.length === 1 ? targets[0]?.resourceUuid : undefined);
      if (!resourceUuid) {
        if (targets.length === 0) {
          return { integrationId: row.id, resourceUuid: null, logs: null, reason: 'no-target' };
        }
        throw new Error(
          'BAD_REQUEST: integration has multiple targets — pass resourceUuid (see list action)',
        );
      }

      try {
        const result = await fetchCoolifyRuntimeLogs(row.pair, resourceUuid, input.lines);
        return { integrationId: row.id, ...result };
      } catch (err) {
        if (err instanceof CoolifyApiError) {
          return {
            integrationId: row.id,
            resourceUuid,
            logs: null,
            error: 'coolify API error',
            httpStatus: err.status,
          };
        }
        throw err;
      }
    }
  }
}

/** Sentinel so a control action returning `undefined` is still a handled one. */
const NOT_A_CONTROL_ACTION = Symbol('not-a-control-action');

/**
 * ISS-925's five actions, split off `dispatchAction` rather than added to it:
 * that function is at its frozen function-length budget, and the deploy path
 * and the controls read better apart anyway.
 */
async function dispatchControlAction(
  input: Input,
  ctx: McpContext,
  principal: McpContext['principal'],
): Promise<unknown> {
  switch (input.action) {
    case 'cancel': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsWriter(principal, projectId);
      return runCoolifyCancel({
        projectId,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
        ...(input.deploymentUuid ? { deploymentUuid: input.deploymentUuid } : {}),
      });
    }
    case 'rollback-images': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);
      return listCoolifyRollbackImages({
        projectId,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
        ...(input.resourceUuid ? { resourceUuid: input.resourceUuid } : {}),
      });
    }
    case 'rollback': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsWriter(principal, projectId);
      if (!input.commit) {
        throw new Error(
          'BAD_REQUEST: rollback needs `commit` — the image tag from rollback-images',
        );
      }
      return runCoolifyRollback({
        projectId,
        commit: input.commit,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
        ...(input.resourceUuid ? { resourceUuid: input.resourceUuid } : {}),
      });
    }
    case 'applications': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);
      return listApplicationsForIntegration({
        projectId,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
      });
    }
    case 'targets': {
      const projectId = await resolveProjectId(input, ctx);
      await assertPrincipalIsMember(principal, projectId);
      return resolveCoolifyTargets({
        projectId,
        ...(input.integrationId ? { integrationId: input.integrationId } : {}),
      });
    }
    default:
      return NOT_A_CONTROL_ACTION;
  }
}
