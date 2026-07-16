/**
 * ISS-604 — the provider-chat tool registry. Mirrors the chat *provider*
 * registry pattern: a curated allowlist over the `forge_*` MCP catalog,
 * resolved per project-context into an OpenAI toolset.
 *
 * ISS-609 extends the P1 read-only set with the write actions the RC bot needs
 * to act on Forge (`forge_issues` create/update + `forge_comments` create).
 * SAFETY: chat-created issues are FORCED to status `draft` — an `open` issue
 * auto-triages and spawns a pipeline run, so only a human flips draft→open.
 * Extend by adding a {@link ChatToolSpec} here — no other file changes.
 */

import { forgeCommentsTool } from '../../mcp/tools/forge-comments.js';
import { forgeIssuesTool } from '../../mcp/tools/forge-issues.js';
import { forgeKnowledgeTool } from '../../mcp/tools/forge-knowledge.js';
import { forgeMemorySearchTool } from '../../mcp/tools/forge-memory.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../mcp/tools/forge-metrics.js';
import { forgePipelineRunsGetTool } from '../../mcp/tools/forge-pipeline-runs.js';
import { forgeProjectPipelineRunsTool } from '../../mcp/tools/forge-project-pipeline-runs.js';
import { forgeProjectStatusSummaryTool } from '../../mcp/tools/forge-project-status-summary.js';
import { forgeProjectsGetTool } from '../../mcp/tools/forge-projects.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { guardIssueWrites } from './guards.js';
import { type ChatToolSpec, type ChatToolset, buildToolset } from './mcp-adapter.js';

/** Curated allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  {
    factory: forgeIssuesTool,
    allowedActions: ['list', 'get', 'listTasks', 'create', 'update'],
    guard: guardIssueWrites,
  },
  { factory: forgeCommentsTool, allowedActions: ['list', 'create'] },
  { factory: forgeKnowledgeTool, allowedActions: ['list', 'get', 'search'] },
  // Project memory (ISS-609 agency follow-up) — the deepest project-context
  // source; memory tools are device-scoped, so adapt via the ctx stub device
  // (its ownerId carries the chat principal for the membership fence).
  { factory: (ctx) => forgeMemorySearchTool(ctx.device) },
  { factory: forgeProjectsGetTool },
  { factory: forgePipelineRunsGetTool },
  { factory: forgeProjectPipelineRunsTool },
  { factory: forgeMetricsProjectStepDurationsTool },
  { factory: forgeMetricsProjectTimeseriesTool },
  // ISS-673 — deterministic done/in-flight/remaining rollup, forced-tool-call
  // exposure so the model reports authoritative counts instead of
  // self-counting raw `forge_issues.list` rows.
  { factory: forgeProjectStatusSummaryTool },
];

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
