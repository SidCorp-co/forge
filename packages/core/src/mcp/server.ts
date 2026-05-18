import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json' with { type: 'json' };
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../auth/mcp-audit.js';
import { forgeAdminHealthTool } from './tools/forge-admin-health.js';
import { forgeAdminProjectsTool } from './tools/forge-admin-projects.js';
import { forgeAdminRunnersTool } from './tools/forge-admin-runners.js';
import { forgeAdminUsersTool } from './tools/forge-admin-users.js';
import {
  forgeAgentSessionsGetTool,
  forgeAgentSessionsListTool,
} from './tools/forge-agent-sessions.js';
import { forgeCommentsTool } from './tools/forge-comments.js';
import { forgeConfigTool } from './tools/forge-config.js';
import { forgeHealthTool } from './tools/forge-health.js';
import { forgeIssuesTool } from './tools/forge-issues.js';
import { forgeJobsEventsTool, forgeJobsGetTool, forgeJobsListTool } from './tools/forge-jobs.js';
import { forgeMemorySearchTool } from './tools/forge-memory.js';
import {
  forgeMetricsAdminStepDurationsTool,
  forgeMetricsProjectStepDurationsTool,
} from './tools/forge-metrics.js';
import {
  forgePipelineRunsCancelTool,
  forgePipelineRunsGetTool,
  forgePipelineRunsListTool,
  forgePipelineRunsPauseTool,
  forgePipelineRunsResumeTool,
} from './tools/forge-pipeline-runs.js';
import { forgePmDispatchTool } from './tools/forge-pm-dispatch.js';
import { forgePmGraphTool } from './tools/forge-pm-graph.js';
import { forgePmRunnerLoadTool } from './tools/forge-pm-runner-load.js';
import { forgePmSetDependencyTool } from './tools/forge-pm-set-dependency.js';
import { forgePmSnapshotTool } from './tools/forge-pm-snapshot.js';
import { forgePmWriteDecisionTool } from './tools/forge-pm-write-decision.js';
import { forgeProjectPipelineRunsTool } from './tools/forge-project-pipeline-runs.js';
import { forgeProjectPmTool } from './tools/forge-project-pm.js';
import { forgeProjectsListTool } from './tools/forge-projects.js';
import {
  forgeSkillsGetTool,
  forgeSkillsListRegistrationsTool,
  forgeSkillsListTool,
  forgeSkillsRegisterTool,
} from './tools/forge-skills.js';
import { type McpTool, forgeVersionTool } from './tools/forge-version.js';
import type { McpContext } from './tools/lib.js';

/**
 * Build an MCP server wired to the per-request {@link McpContext}. Tool
 * factories receive the device (and optional project slug) so handlers can
 * enforce project-scope access.
 *
 * Tools:
 *  - `forge_version` — no context needed (uptime/version).
 *  - `forge_memory.search` — wraps `runMemorySearch` (ISS-198).
 *  - `forge_skills.list` / `.get` / `.register` — wrap ISS-196 REST logic.
 *  - `forge_issues` / `forge_comments` / `forge_config` — action-based parity
 *    with the legacy Strapi MCP so existing `/forge-*` skills work unchanged
 *    (ISS-293). Task CRUD lives on `forge_issues` as actions `createTask` /
 *    `listTasks` / `updateTask` / `deleteTask` (ISS-146).
 *  - `forge_jobs.list` / `.get` / `.events` — read-only diagnostic surfaces
 *    over jobs + job_events (ISS-7).
 *  - `forge_agent_sessions.list` / `.get` — read-only access to
 *    `agent_sessions` rows (ISS-7).
 *  - `forge_project_pipeline_runs` — action dispatcher
 *    (list/get/pause/resume/cancel) for `pipeline_runs` (ISS-145). The
 *    legacy `forge_pipeline_runs.<action>` tools stay registered as
 *    forwarding shims that emit `X-MCP-Deprecation`.
 *  - `forge_project_pm` — action dispatcher
 *    (snapshot/graph/runner_load/dispatch/set_dependency/write_decision)
 *    for the PM agent surface (ISS-145). The matching legacy
 *    `forge_pm.<action>` tools stay as shims. `flag_blocker` and the
 *    standalone `escalate` tool were removed in ISS-146 (escalation now
 *    lives on `write_decision.escalate`).
 *  - `forge_projects.list` — enumerate projects visible to the device owner
 *    (ISS-7, pre-req for ISS-9).
 *  - `forge_health` — server snapshot: db/queue/ws + last seed + active jobs
 *    (ISS-7). Device-token only.
 */
/**
 * Tools that intrinsically require a paired device — they query `runners`
 * by `device.id` or otherwise assume the principal owns local runner state.
 * For PAT principals these tools 403 with `PM_REQUIRES_DEVICE` before any
 * DB call is made, both to surface a clean error and to avoid leaking the
 * stub-device id into a downstream FK lookup.
 *
 * ISS-145 — gating is now `(tool, action)` to account for the consolidated
 * `forge_project_pm` dispatcher: a `true` value gates the whole tool name
 * (legacy shims keep this for byte-identical behaviour), a `Set<string>`
 * gates per-action so PAT callers can still invoke unrelated actions on a
 * dispatcher that happens to host device-only actions.
 */
const DEVICE_REQUIRED: ReadonlyMap<string, ReadonlySet<string> | true> = new Map<
  string,
  ReadonlySet<string> | true
>([
  [
    'forge_project_pm',
    new Set([
      'snapshot',
      'graph',
      'runner_load',
      'dispatch',
      'set_dependency',
      'write_decision',
    ]),
  ],
  // Legacy shims keep the per-tool gate so the deprecation window is
  // byte-identical to the pre-consolidation behaviour.
  ['forge_pm.snapshot', true],
  ['forge_pm.graph', true],
  ['forge_pm.runner_load', true],
  ['forge_pm.dispatch', true],
  ['forge_pm.set_dependency', true],
  ['forge_pm.write_decision', true],
]);

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
    forgeVersionTool,
    forgeMemorySearchTool(ctx.device),
    forgeSkillsListTool(ctx.device),
    forgeSkillsGetTool(ctx.device),
    forgeSkillsRegisterTool(ctx.device),
    forgeSkillsListRegistrationsTool(ctx),
    forgeMetricsAdminStepDurationsTool(ctx),
    forgeMetricsProjectStepDurationsTool(ctx),
    forgeAdminProjectsTool(ctx),
    forgeAdminRunnersTool(ctx),
    forgeAdminUsersTool(ctx),
    forgeAdminHealthTool(ctx),
    forgeIssuesTool(ctx),
    forgeCommentsTool(ctx),
    forgeConfigTool(ctx),
    forgeJobsListTool(ctx.device),
    forgeJobsGetTool(ctx),
    forgeJobsEventsTool(ctx),
    forgeAgentSessionsListTool(ctx.device),
    forgeAgentSessionsGetTool(ctx),
    // ISS-145 — consolidated dispatchers first; legacy shims registered
    // immediately after so `tools/list` order remains stable for callers
    // that pin to the existing position.
    forgeProjectPipelineRunsTool(ctx),
    forgePipelineRunsListTool(ctx),
    forgePipelineRunsGetTool(ctx),
    forgePipelineRunsPauseTool(ctx),
    forgePipelineRunsResumeTool(ctx),
    forgePipelineRunsCancelTool(ctx),
    forgeProjectsListTool(ctx),
    forgeProjectPmTool(ctx),
    forgePmSnapshotTool(ctx),
    forgePmGraphTool(ctx),
    forgePmRunnerLoadTool(ctx),
    forgePmDispatchTool(ctx),
    forgePmSetDependencyTool(ctx),
    forgePmWriteDecisionTool(ctx),
    forgeHealthTool(ctx.device),
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: '@forge/core', version: pkg.version },
    { capabilities: { tools: {} } },
  );

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
    const auditBase = {
      userId: principal.kind === 'pat' ? principal.userId : principal.device.ownerId,
      tokenId: principal.kind === 'pat' ? principal.tokenId : null,
      deviceId: principal.kind === 'device' ? principal.device.id : null,
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

    // PAT principals can't run device-only tools or device-only actions on
    // a consolidated dispatcher. Surface a stable error code so callers
    // (Cursor/Cline) can present a clear message.
    if (principal.kind === 'pat') {
      const gate = DEVICE_REQUIRED.get(name);
      const action = typeof args.action === 'string' ? args.action : null;
      const blocked = gate === true || (gate instanceof Set && action !== null && gate.has(action));
      if (blocked) {
        writeMcpAudit({ ...auditBase, resultCode: 'forbidden' });
        return {
          content: [{ type: 'text', text: 'FORBIDDEN: PM_REQUIRES_DEVICE' }],
          isError: true,
        };
      }
    }

    // PAT projectIds allowlist — enforce before the tool runs so we 404
    // (NOT 403) when the caller probes a project outside their scope.
    if (principal.kind === 'pat' && principal.projectIds !== null) {
      const target = auditBase.projectId;
      if (target && !principal.projectIds.includes(target)) {
        writeMcpAudit({ ...auditBase, resultCode: 'not_found' });
        return {
          content: [{ type: 'text', text: 'NOT_FOUND: project not found or not accessible' }],
          isError: true,
        };
      }
    }

    try {
      const result = await tool.handler(args);
      const structured =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result };
      writeMcpAudit({ ...auditBase, resultCode: 'ok' });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: structured,
      };
    } catch (err) {
      const { code, message } = classifyError(err);
      writeMcpAudit({ ...auditBase, resultCode: code });
      // Strip any FORBIDDEN/NOT_FOUND prefix that exists only for the
      // server-side mapper — surface the human message to the caller.
      const text = message.replace(/^(?:FORBIDDEN|NOT_FOUND|BAD_REQUEST):\s*/, '');
      return {
        content: [{ type: 'text', text: `Error: ${text}` }],
        isError: true,
      };
    }
  });

  return server;
}
