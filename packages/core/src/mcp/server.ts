import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../auth/mcp-audit.js';
import { resolveManagedMetaPrompts } from '../skills/effective.js';
import { FORGE_MCP_INSTRUCTIONS } from './instructions.js';
import { toToolCallContent } from './tool-result.js';
import {
  forgeAgentSessionsGetTool,
  forgeAgentSessionsListTool,
} from './tools/forge-agent-sessions.js';
import { forgeCollaboratorsTool } from './tools/forge-collaborators.js';
import { forgeCommentsTool } from './tools/forge-comments.js';
import { forgeConfigTool } from './tools/forge-config.js';
import { forgeCoolifyDeployTool } from './tools/forge-coolify-deploy.js';
import { forgeFeedbackTool } from './tools/forge-feedback.js';
import { forgeGuideTool } from './tools/forge-guide.js';
import { forgeHealthTool } from './tools/forge-health.js';
import { forgeIssuesTool } from './tools/forge-issues.js';
import {
  forgeJobsCancelTool,
  forgeJobsEventsTool,
  forgeJobsGetTool,
  forgeJobsListTool,
  forgeJobsResumeTool,
} from './tools/forge-jobs.js';
import { forgeKnowledgeTool } from './tools/forge-knowledge.js';
import {
  forgeMemoryDeleteTool,
  forgeMemoryFeedbackTool,
  forgeMemoryGetTool,
  forgeMemorySearchTool,
  forgeMemoryWriteTool,
} from './tools/forge-memory.js';
import {
  forgeMetricsProjectRetryRescuesTool,
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
  forgeMetricsSessionFailuresTool,
} from './tools/forge-metrics.js';
import { forgeOrgsListTool, forgeOrgsMembersTool } from './tools/forge-orgs.js';
import { forgePhaseTool } from './tools/forge-phase.js';
// cm:guard ISS-483 §E#3 unregistered the 9 zero-reference `forge_pipeline_runs.*` / `forge_pm.*` shims and 2026-08-31 deleted their factories and deprecation notices, but the per-action HANDLERS in those same files are NOT shims — `forge_project_pm` and `forge_project_pipeline_runs` dispatch into every one of them, so deleting a `forge-pm-*.ts` file along with its retired factory breaks the dispatcher, and those five test files remain the only coverage runner_load, dispatch and write_decision have. Only `forge_pipeline_runs.get` (forge-skill-audit) and `forge_pm.set_dependency` (forge-plan, forge-triage, forge-build) are still registered, each because a live skill calls it by name.
import { forgePipelineRunsGetTool } from './tools/forge-pipeline-runs.js';
import { forgePmSetDependencyTool } from './tools/forge-pm-set-dependency.js';
import { forgeProjectPipelineRunsTool } from './tools/forge-project-pipeline-runs.js';
import { forgeProjectPmTool } from './tools/forge-project-pm.js';
import {
  forgeProjectsCreateTool,
  forgeProjectsGetTool,
  forgeProjectsListTool,
  forgeProjectsUpdateTool,
} from './tools/forge-projects.js';
import { forgeReconcileTool } from './tools/forge-reconcile.js';
import { forgeRunnersTool } from './tools/forge-runners.js';
import { forgeSchedulesTool } from './tools/forge-schedules.js';
import { forgeSkillFactsGetTool, forgeSkillFactsListTool } from './tools/forge-skill-facts.js';
import {
  forgeSkillsAdoptTool,
  forgeSkillsCreateTool,
  forgeSkillsDeleteTool,
  forgeSkillsEffectiveTool,
  forgeSkillsGetTool,
  forgeSkillsListRegistrationsTool,
  forgeSkillsListTool,
  forgeSkillsPushTool,
  forgeSkillsRegisterTool,
  forgeSkillsSyncStatusTool,
  forgeSkillsUpdateTool,
} from './tools/forge-skills.js';
import {
  forgeStepHandoffDeleteTool,
  forgeStepHandoffGetTool,
  forgeStepHandoffWriteTool,
} from './tools/forge-step-handoff.js';
import { forgeStepStartTool } from './tools/forge-step-start.js';
import { forgeStorefrontTargetTool } from './tools/forge-storefront-target.js';
import { forgeUploadsTool } from './tools/forge-uploads.js';
import { forgeUxFindingsTool } from './tools/forge-ux-findings.js';
import type { McpContext, McpTool } from './tools/lib.js';
import { patEffectiveProjectIds, resolveProjectIdFromSlug } from './tools/project-scope.js';

/**
 * Build an MCP server wired to the per-request {@link McpContext}. Tool
 * factories receive the device (and optional project slug) so handlers can
 * enforce project-scope access.
 *
 * Tools:
 *  - `forge_memory.search` — wraps `runMemorySearch` (ISS-198).
 *  - `forge_skills.list` / `.get` / `.register` — wrap ISS-196 REST logic.
 *  - `forge_issues` / `forge_comments` / `forge_config` — action-based parity
 *    with the legacy Strapi MCP so existing `/forge-*` skills work unchanged
 *    (ISS-293). Task CRUD lives on `forge_issues` as actions `createTask` /
 *    `listTasks` / `updateTask` / `deleteTask` (ISS-146).
 *  - `forge_jobs.list` / `.get` / `.events` — read-only diagnostic surfaces
 *    over jobs + job_events (ISS-7). `forge_jobs.cancel` — writer-gated
 *    audited single-job cancel (ISS-442 C0); the manual escape hatch that
 *    also clears jobs orphaned under an already-terminal pipeline_run.
 *  - `forge_agent_sessions.list` / `.get` — read-only access to
 *    `agent_sessions` rows (ISS-7).
 *  - `forge_project_pipeline_runs` — action dispatcher
 *    (list/get/pause/resume/cancel) for `pipeline_runs` (ISS-145). ISS-483
 *    §E#3 retired the zero-reference legacy `forge_pipeline_runs.<action>`
 *    shims; only `forge_pipeline_runs.get` stays registered (still referenced
 *    by forge-skill-audit) and emits `X-MCP-Deprecation`.
 *  - `forge_project_pm` — action dispatcher
 *    (snapshot/graph/runner_load/dispatch/set_dependency/write_decision)
 *    for the PM agent surface (ISS-145). ISS-483 §E#3 retired the matching
 *    legacy `forge_pm.<action>` shims; only `forge_pm.set_dependency` stays
 *    registered (still referenced by forge-plan). `flag_blocker` and the
 *    standalone `escalate` tool were removed earlier in ISS-146 (escalation
 *    now lives on `write_decision.escalate`).
 *  - `forge_projects.list` — enumerate projects visible to the caller
 *    (ISS-7, pre-req for ISS-9).
 *  - `forge_projects.create` / `.update` / `.archive` — user-facing project
 *    provisioning over MCP. The caller always becomes owner of a created
 *    project; there is no cross-tenant create path.
 *  - `forge_coolify_deploy` — action dispatcher (list/deploy/status) for the
 *    Coolify deploy step the stock pipeline skills invoke (ISS-242). Input:
 *    `{ action: 'list'|'deploy'|'status', projectId?, issueId?, integrationId? }`.
 *    `list`/`status` are project-scoped (slug header or projectId); `deploy`
 *    additionally requires `issueId` (MCP has no run context) and delegates to
 *    the release auto-subscriber's exact dispatch path so manual + auto deploys
 *    dedupe on `requestId = runId:integrationId`. Prod integrations return
 *    `pendingHumanConfirm:true` without dispatching until the confirm-prod gate
 *    is released. Membership-gated; no device requirement.
 *  - `forge_health` — server snapshot: db/queue/ws + last seed + active jobs
 *    (ISS-7). No project scope.
 */

function classifyError(err: unknown): { code: AuditResultCode; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('NOT_FOUND')) return { code: 'not_found', message };
  if (message.startsWith('FORBIDDEN')) return { code: 'forbidden', message };
  return { code: 'error', message };
}

/**
 * Extract a project hint from raw args — used to enforce a PAT's
 * `projectIds` allowlist generically across every tool. We accept the
 * common arg names (`projectId`, `projectSlug`, plus filter sub-objects)
 * and return null when no hint is found.
 */
function projectIdFromArgs(args: Record<string, unknown>): string | null {
  const top = args.projectId;
  if (typeof top === 'string') return top;
  const filters = args.filters;
  if (filters && typeof filters === 'object') {
    const fid = (filters as Record<string, unknown>).projectId;
    if (typeof fid === 'string') return fid;
  }
  return null;
}

export function createMcpServer(ctx: McpContext): Server {
  const { principal } = ctx;
  const tools: McpTool[] = [
    forgeMemorySearchTool(ctx),
    forgeMemoryWriteTool(ctx),
    forgeMemoryGetTool(ctx),
    forgeMemoryDeleteTool(ctx),
    forgeMemoryFeedbackTool(ctx),
    forgeStepHandoffWriteTool(ctx),
    forgeStepHandoffGetTool(ctx),
    forgeStepHandoffDeleteTool(ctx),
    forgeSkillsListTool(ctx),
    forgeSkillsGetTool(ctx),
    forgeSkillsRegisterTool(ctx),
    forgeSkillsListRegistrationsTool(ctx),
    forgeSkillsCreateTool(ctx),
    forgeSkillsUpdateTool(ctx),
    forgeSkillsDeleteTool(ctx),
    forgeSkillsEffectiveTool(ctx),
    forgeSkillsAdoptTool(ctx),
    forgeSkillsSyncStatusTool(ctx),
    forgeSkillsPushTool(ctx),
    forgeSkillFactsListTool(ctx),
    forgeSkillFactsGetTool(ctx),
    forgeMetricsProjectRetryRescuesTool(ctx),
    forgeMetricsProjectStepDurationsTool(ctx),
    forgeMetricsProjectTimeseriesTool(ctx),
    forgeRunnersTool(ctx),
    forgeSchedulesTool(ctx),
    forgeCollaboratorsTool(ctx),
    forgeIssuesTool(ctx),
    forgePhaseTool(ctx),
    forgeStepStartTool(ctx),
    forgeCommentsTool(ctx),
    forgeFeedbackTool(ctx),
    forgeUxFindingsTool(ctx),
    forgeUploadsTool(ctx),
    forgeConfigTool(ctx),
    forgeKnowledgeTool(ctx),
    forgeCoolifyDeployTool(ctx),
    forgeStorefrontTargetTool(ctx),
    forgeJobsListTool(ctx),
    forgeJobsGetTool(ctx),
    forgeJobsEventsTool(ctx),
    forgeJobsCancelTool(ctx),
    forgeAgentSessionsListTool(ctx),
    forgeAgentSessionsGetTool(ctx),
    // cm:guard a surviving shim is registered IMMEDIATELY after the dispatcher that supersedes it — `tools/list` order is positional for callers that pin to it, so inserting elsewhere silently moves every tool after it (ISS-145)
    forgeProjectPipelineRunsTool(ctx),
    forgePipelineRunsGetTool(ctx),
    forgeProjectsListTool(ctx),
    forgeProjectsCreateTool(ctx),
    forgeOrgsListTool(ctx),
    forgeOrgsMembersTool(ctx),
    forgeProjectsUpdateTool(ctx),
    forgeProjectsGetTool(ctx),
    forgeProjectPmTool(ctx),
    forgePmSetDependencyTool(ctx),
    forgeHealthTool(ctx),
    forgeReconcileTool(ctx),
    // cm:guard append new tools HERE, immediately above the last one — every position shifts the indices below it, so the tail is the only insertion point that leaves all existing tools where callers pinned them
    forgeJobsResumeTool(ctx),
    forgeMetricsSessionFailuresTool(ctx),
    // cm:guard keep this registration LAST — callers pin to `tools/list` ordering, so inserting above it shifts every index they rely on
    forgeGuideTool(ctx),
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: '@forge/core', version: pkg.version },
    { capabilities: { tools: {}, prompts: {} }, instructions: FORGE_MCP_INSTRUCTIONS },
  );

  // cm:guard precedence is slug > boundProjectId, the SAME order the tool resolver uses — meta skills are served live as prompts rather than synced to disk, so the two resolvers disagreeing means a session reads one project's tools and another project's guidance in the same breath, with nothing on disk to compare against (ISS-497)
  const metaProjectId = async (): Promise<string | null> => {
    if (ctx.projectSlug) {
      try {
        return await resolveProjectIdFromSlug(ctx.projectSlug);
      } catch {
        return null;
      }
    }
    return ctx.boundProjectId ?? null;
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    return { prompts: prompts.map((p) => ({ name: p.name, description: p.description })) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompts = await resolveManagedMetaPrompts(await metaProjectId());
    const p = prompts.find((x) => x.name === request.params.name);
    if (!p) throw new Error(`unknown prompt: ${request.params.name}`);
    return {
      description: p.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.body } }],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const tool = toolMap.get(name);
    // cm:guard `deviceId` stays NULL on every row this writes, and the column stays in the shape rather than being dropped: `agent-surface.md` reads `mcp_audit_log` split on `device_id IS NOT NULL` to decide which tools ISS-894 may delete, and a schema with no device column would answer that question with silence instead of a zero. Since ISS-931 the only writer of a non-null `device_id` is history.
    const auditBase = {
      userId: principal.userId,
      tokenId: principal.tokenId,
      deviceId: null,
      tool: name,
      action: typeof args.action === 'string' ? args.action : null,
      projectId: projectIdFromArgs(args),
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      payloadDigest: digestArgs(args),
    };

    if (!tool) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // cm:guard 404 and NOT 403 when a caller probes a project outside its token's scope — 403 confirms the project exists, which turns this tool into an existence oracle for every project the caller cannot see. This fences the explicit-arg path only; the slug-resolved path is fenced inside the assertPrincipalIs* helpers (ISS-497).
    const allow = patEffectiveProjectIds(principal);
    const target = auditBase.projectId;
    if (allow !== null && target && !allow.includes(target)) {
      writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
      return {
        content: [{ type: 'text', text: 'NOT_FOUND: project not found or not accessible' }],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args);
      writeMcpAudit({ ...auditBase, resultCode: 'ok' });
      return toToolCallContent(result);
    } catch (err) {
      const { code, message } = classifyError(err);
      writeMcpAudit({ ...auditBase, resultCode: code });
      // cm:edge contract -> packages/core/src/mcp/tools/lib.ts — the prefix is how a thrown error carries its class to `classifyError`; it is consumed HERE and must not reach the caller, who would read `FORBIDDEN: ...` as part of the message
      const text = message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '');
      return {
        content: [{ type: 'text', text: `Error: ${text}` }],
        isError: true,
      };
    }
  });

  return server;
}
