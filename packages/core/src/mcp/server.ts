import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type AuditResultCode, digestArgs, writeMcpAudit } from '../auth/mcp-audit.js';
import pkg from '../../package.json' with { type: 'json' };
import {
  forgeAgentSessionsGetTool,
  forgeAgentSessionsListTool,
} from './tools/forge-agent-sessions.js';
import {
  forgePipelineRunsCancelTool,
  forgePipelineRunsGetTool,
  forgePipelineRunsListTool,
  forgePipelineRunsPauseTool,
  forgePipelineRunsResumeTool,
} from './tools/forge-pipeline-runs.js';
import { forgeCommentsTool } from './tools/forge-comments.js';
import { forgeConfigTool } from './tools/forge-config.js';
import { forgeHealthTool } from './tools/forge-health.js';
import { forgeIssuesTool } from './tools/forge-issues.js';
import {
  forgeJobsEventsTool,
  forgeJobsGetTool,
  forgeJobsListTool,
} from './tools/forge-jobs.js';
import { forgeMemorySearchTool } from './tools/forge-memory.js';
import { forgePmDispatchTool } from './tools/forge-pm-dispatch.js';
import { forgePmEscalateTool } from './tools/forge-pm-escalate.js';
import { forgePmFlagBlockerTool } from './tools/forge-pm-flag-blocker.js';
import { forgePmGraphTool } from './tools/forge-pm-graph.js';
import { forgePmRunnerLoadTool } from './tools/forge-pm-runner-load.js';
import { forgePmSetDependencyTool } from './tools/forge-pm-set-dependency.js';
import { forgePmSnapshotTool } from './tools/forge-pm-snapshot.js';
import { forgePmWriteDecisionTool } from './tools/forge-pm-write-decision.js';
import { forgeProjectsListTool } from './tools/forge-projects.js';
import {
  forgeSkillsGetTool,
  forgeSkillsListTool,
  forgeSkillsRegisterTool,
} from './tools/forge-skills.js';
import { forgeTasksTool } from './tools/forge-tasks.js';
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
 *  - `forge_issues` / `forge_comments` / `forge_config` / `forge_tasks` —
 *    action-based parity with the legacy Strapi MCP so existing `/forge-*`
 *    skills work unchanged (ISS-293).
 *  - `forge_jobs.list` / `.get` / `.events` — read-only diagnostic surfaces
 *    over jobs + job_events (ISS-7).
 *  - `forge_agent_sessions.list` / `.get` — read-only access to
 *    `agent_sessions` rows (ISS-7).
 *  - `forge_pipeline_runs.list` / `.get` / `.pause` / `.resume` / `.cancel` —
 *    REST-paritied lifecycle controls for `pipeline_runs` (ISS-102).
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
 */
const DEVICE_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'forge_pm_snapshot',
  'forge_pm_graph',
  'forge_pm_runner-load',
  'forge_pm_dispatch',
  'forge_pm_set-dependency',
  'forge_pm_flag-blocker',
  'forge_pm_escalate',
  'forge_pm_write-decision',
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
  const { device, principal } = ctx;
  const tools: McpTool[] = [
    forgeVersionTool,
    forgeMemorySearchTool(device),
    forgeSkillsListTool(device),
    forgeSkillsGetTool(device),
    forgeSkillsRegisterTool(device),
    forgeIssuesTool(ctx),
    forgeCommentsTool(ctx),
    forgeConfigTool(ctx),
    forgeTasksTool(ctx),
    forgeJobsListTool(device),
    forgeJobsGetTool(device),
    forgeJobsEventsTool(device),
    forgeAgentSessionsListTool(device),
    forgeAgentSessionsGetTool(device),
    forgePipelineRunsListTool(device),
    forgePipelineRunsGetTool(device),
    forgePipelineRunsPauseTool(device),
    forgePipelineRunsResumeTool(device),
    forgePipelineRunsCancelTool(device),
    forgeProjectsListTool(device),
    forgePmSnapshotTool(device),
    forgePmGraphTool(device),
    forgePmRunnerLoadTool(device),
    forgePmDispatchTool(device),
    forgePmSetDependencyTool(device),
    forgePmFlagBlockerTool(device),
    forgePmEscalateTool(device),
    forgePmWriteDecisionTool(device),
    forgeHealthTool(device),
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

    // PAT principals can't run device-only tools. Surface a stable error
    // code so callers (Cursor/Cline) can present a clear message.
    if (principal.kind === 'pat' && DEVICE_REQUIRED_TOOLS.has(name)) {
      writeMcpAudit({ ...auditBase, resultCode: 'forbidden' });
      return {
        content: [{ type: 'text', text: 'FORBIDDEN: PM_REQUIRES_DEVICE' }],
        isError: true,
      };
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
