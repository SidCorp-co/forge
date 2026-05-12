import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
export function createMcpServer(ctx: McpContext): Server {
  const { device } = ctx;
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
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      const structured =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { value: result };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: structured,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
