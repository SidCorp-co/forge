/**
 * ISS-242 — Action-dispatcher MCP tool `forge_coolify_deploy` that the stock
 * pipeline skills (forge-release / forge-staging / forge-code / forge-fix /
 * forge-test) already call but which had no server-side implementation,
 * causing a tool-not-found at the deploy step.
 *
 * The action list and what each one returns live in the tool `description`
 * below — it is what a model actually reads, and a second copy here is a copy
 * that goes stale. ISS-925 added the controls beside deploy: `cancel`,
 * `rollback-images`, `rollback`, `applications`, `targets`. REQ-39 BC-7 added `targets` on `deploy`:
 * the fast lane's web-only deploy, which the fast lane's guard (`fast-lane:deployWebOnly`) refuses
 * unless every commit since what those targets serve classifies fast.
 *
 * Authorization is `project.read`, raised to `deploys.run` for the three actions that change something;
 * prod safety is the human-confirm gate inside `tryDispatchCoolifyRelease` and
 * `prodActionNeedsHumanConfirm`, not RBAC. No DEVICE_REQUIRED entry — the tool
 * has no runner dependency.
 */

import type { CoolifyRefusalCode } from '@forge/contracts/integrations';
import { z } from 'zod';
import { deployWebOnly } from '../fast-lane/index.js';
import {
  type CoolifyConfig,
  fetchCoolifyDeploymentLogs,
  fetchCoolifyRuntimeLogs,
} from '../integrations/deploy/index.js';
import { findLastOutbound } from '../integrations/index.js';
import { refuser } from '../lib/refusal.js';
import { type ContextScopedMcpToolFactory, type McpContext, zodToMcpSchema } from '../lib/tool.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { resolveEffectiveProjectId } from '../projects/index.js';
import {
  activeCoolifyIntegrations,
  coolifyDeliveryStatus,
  listApplicationsForIntegration,
  listCoolifyIntegrations,
  listCoolifyRollbackImages,
  resolveCoolifyTargets,
  resolveIntegrationRow,
  runCoolifyCancel,
  runCoolifyDeploy,
  runCoolifyRollback,
} from '../release-batch/index.js';
import { coolifyRefusal, given, requireCoolifyRun } from './coolify-access.js';

const refuseCoolify = refuser<CoolifyRefusalCode>('COOLIFY_REFUSED');

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
     *  dispatches to production too (allowLive=true) through the shared release path. */
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
    /** deploy: the labels of the targets to deploy and no others — the fast lane's web-only deploy. */
    targets: z.array(z.string().min(1).max(100)).min(1).max(5).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const forgeCoolifyDeployTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_coolify_deploy',
  reach: 'project',
  route: '/api/projects',
  grant: {
    byAction: {
      list: 'projects:read',
      deploy: 'projects:write',
      status: 'projects:read',
      logs: 'projects:read',
      'runtime-logs': 'projects:read',
      cancel: 'projects:write',
      'rollback-images': 'projects:read',
      rollback: 'projects:write',
      applications: 'projects:read',
      targets: 'projects:read',
    },
  },
  description:
    'Coolify deploy controls for the pipeline skills. Actions: list | deploy | status | logs | ' +
    'runtime-logs | cancel | rollback-images | rollback | applications | targets. ' +
    'MODEL: one integration = one project+ROLE binding. A `deploy` binding serves the ONE ' +
    'environment of the project document whose `deployment.binding` names it, and only such a ' +
    'binding is dispatched; an environment whose trigger is `provider` deploys itself and is ' +
    'skipped. Two environments on one Coolify application is a configuration, not a rule: read ' +
    'each binding `environment`. Each integration deploys ONE OR MORE targets[] — each target is its own Coolify ' +
    'application (e.g. a split backend + frontend, or a worker), deployed TOGETHER. A single deploy ' +
    'FANS OUT to every target of the integration (one Coolify build per target); the pipeline run is ' +
    'marked done only when EVERY target webhook reports success, and FAILS on the first target ' +
    'failure. So if an app (e.g. the backend) is not deploying, check it is CONFIGURED as a target on ' +
    'that integration (project settings → Integrations) — Forge only deploys the targets the ' +
    'integration holds. ' +
    'list: active Coolify integrations for the project (id, environment, targets[]={id,label,' +
    'resourceUuid}, lastHealthStatus, breakerOpen); empty array => project is local-only (no Coolify). ' +
    'Inspect targets[] to confirm every app you expect (BE+FE) is present. ' +
    'deploy: issueId is OPTIONAL; dispatches ALL targets of the resolved integration unless `targets` ' +
    'names some. `targets` (labels, e.g. ["web"]) is the FAST LANE web-only deploy (REQ-39): only ' +
    "labels the project document's `fastLane.deployTargets` declares, on one binding (integrationId, " +
    'else the sole active one), never with pipelineRunId; refused FAST_LANE_NOT_ELIGIBLE unless every ' +
    "commit between the commit each target serves and its environment's deploysFrom head touches " +
    'only fast files (naming the commit, file and rule), FAST_LANE_UNVERIFIED where that cannot be ' +
    'read whole, FAST_LANE_UNDECLARED where the project or binding does not declare the target. On ' +
    'success it answers `lane: "fast"` and, per target, the served commit, the head and the commit ' +
    'count; verify by the commit the web build serves (`logs` -> `commit`). With issueId — ' +
    "run-tracked deploy: resolves the issue's latest pipeline run and enqueues via the SAME path as " +
    'every release deploy (each target webhook then advances that run; run completes when all ' +
    'targets succeed). When issueId is combined with integrationId, integrationId is a HARD scope ' +
    'filter — ONLY that binding dispatches, even if other bindings (e.g. prod) exist on the run. ' +
    'When issueId is given WITHOUT integrationId, bindings reaching production (its binding, or one ' +
    'deploying to an application it also deploys to) are dispatched ONLY when ' +
    'the issue has reached the release stage (status awaiting_release/closed) — every pre-release call ' +
    '(code/fix/testing) reaches every environment but production and NEVER touches a production ' +
    'binding, whatever its trigger (`on-land` waives the human-confirm gate at the release stage, ' +
    'never the pre-release filter). With pipelineRunId (no issueId) — ISS-764 ' +
    'batch release path: the run is already open (kind=system); dispatches ALL targets live-allowed ' +
    '(allowLive=true) via the shared release path. The live human-confirm gate still applies — ' +
    'pendingHumanConfirm:true means abort the batch. Mutually exclusive with issueId. ' +
    'Without issueId or pipelineRunId — run-less resource redeploy: ' +
    'resolves the target integration like the logs action (explicit integrationId, else the single ' +
    'active Coolify integration, else BAD_REQUEST when multiple exist) and dispatches with no run ' +
    'attached (webhooks record deliveries but advance no pipeline). Each call is its own dispatch ' +
    '(per-attempt requestId, suffixed per target) and Coolify force-rebuilds, so re-deploying after a ' +
    'branch fix fires fresh builds. At the release stage, prod integrations still honor the ' +
    "human-confirm gate (unless the project document's production environment deploys `on-land`): returns " +
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
    "both return pendingHumanConfirm:true and do nothing unless the project document's production " +
    'environment deploys `on-land`. ' +
    'applications: every Coolify application this credential can see — { uuid, name, fqdn, ' +
    'gitRepository, gitBranch, gitCommitSha, status }. The pick-list that replaces transcribing a ' +
    'resourceUuid. ' +
    'targets: the bound targets of one integration resolved against that list, each with its ' +
    'Coolify identity and `found:false` when Coolify does not list the bound uuid — which is how a ' +
    'wrong binding is visible without opening Coolify. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership; deploy, cancel and rollback need deploys.run.',
  inputSchema: zodToMcpSchema(inputSchema),
  // Coolify's own refusal is refused by name, never folded into a success-shaped answer.
  handler: async (args) => {
    try {
      return await dispatchAction(inputSchema.parse(args), ctx);
    } catch (err) {
      const said = coolifyRefusal(err);
      throw said === null ? err : refuseCoolify('COOLIFY_REFUSED', said);
    }
  },
});

async function dispatchAction(input: Input, ctx: McpContext): Promise<unknown> {
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const { principal } = ctx;
  const { action } = input;
  if (action === 'deploy' || action === 'cancel' || action === 'rollback') {
    await requireCoolifyRun(actorFor(principal.userId, principal.agency), projectId, action);
  } else {
    await requireCan(actorFor(principal.userId), 'project.read', projectResource(projectId));
  }
  const scope = given({ integrationId: input.integrationId });
  switch (action) {
    case 'list':
      return listCoolifyIntegrations(projectId);
    case 'deploy':
      if (input.targets) {
        if (input.pipelineRunId) {
          throw new Error(
            'BAD_REQUEST: `targets` is the fast lane web-only deploy, which deploys by issue or binding; a release run (pipelineRunId) deploys every target',
          );
        }
        return deployWebOnly({
          projectId,
          targets: input.targets,
          ...given({ issueId: input.issueId }),
          ...scope,
        });
      }
      return runCoolifyDeploy({
        projectId,
        ...given({ issueId: input.issueId, pipelineRunId: input.pipelineRunId }),
        ...scope,
      });
    case 'status':
      return coolifyDeliveryStatus({ projectId, ...scope });
    case 'logs':
      return deploymentLogs(projectId, input);
    case 'runtime-logs':
      return runtimeLogs(projectId, input);
    case 'cancel':
      return runCoolifyCancel({
        projectId,
        ...scope,
        ...given({ deploymentUuid: input.deploymentUuid }),
      });
    case 'rollback-images':
      return listCoolifyRollbackImages({
        projectId,
        ...scope,
        ...given({ resourceUuid: input.resourceUuid }),
      });
    case 'rollback':
      if (!input.commit) {
        throw new Error(
          'BAD_REQUEST: rollback needs `commit` — the image tag from rollback-images',
        );
      }
      return runCoolifyRollback({
        projectId,
        commit: input.commit,
        ...scope,
        ...given({ resourceUuid: input.resourceUuid }),
      });
    case 'applications':
      return listApplicationsForIntegration({ projectId, ...scope });
    case 'targets':
      return resolveCoolifyTargets({ projectId, ...scope });
  }
}

/** A deployment's build log: the named deployment, else the integration's last outbound one. */
async function deploymentLogs(projectId: string, input: Input) {
  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row)
    return { integrationId: null, deploymentUuid: null, logs: null, reason: 'no-integration' };
  const last = input.deploymentUuid ? null : await findLastOutbound(row.id);
  const deploymentUuid =
    input.deploymentUuid ??
    (last?.response as { deployment_uuid?: string } | null)?.deployment_uuid ??
    null;
  if (!deploymentUuid) {
    return { integrationId: row.id, deploymentUuid: null, logs: null, reason: 'no-deployment' };
  }
  return {
    integrationId: row.id,
    ...(await fetchCoolifyDeploymentLogs(row.pair, deploymentUuid, input.lines)),
  };
}

/**
 * The live container log of one target: the named resourceUuid, else the integration's sole target.
 * For a docker-compose application Coolify returns one container's log, whichever target is named.
 */
async function runtimeLogs(projectId: string, input: Input) {
  const row = resolveIntegrationRow(await activeCoolifyIntegrations(projectId), input);
  if (!row)
    return { integrationId: null, resourceUuid: null, logs: null, reason: 'no-integration' };
  const targets = (row.config as CoolifyConfig | null)?.targets ?? [];
  const resourceUuid =
    input.resourceUuid ?? (targets.length === 1 ? targets[0]?.resourceUuid : undefined);
  if (!resourceUuid) {
    if (targets.length === 0)
      return { integrationId: row.id, resourceUuid: null, logs: null, reason: 'no-target' };
    throw new Error(
      'BAD_REQUEST: integration has multiple targets — pass resourceUuid (see list action)',
    );
  }
  return {
    integrationId: row.id,
    ...(await fetchCoolifyRuntimeLogs(row.pair, resourceUuid, input.lines)),
  };
}
