/**
 * ISS-604 — the provider-chat tool registry. Mirrors the chat *provider*
 * registry pattern: a curated, read-only allowlist over the `forge_*` MCP
 * catalog, resolved per project-context into an OpenAI toolset.
 *
 * Read-only for the MVP (decision B): every multi-action tool is fenced to its
 * read actions; write tools (create/transition/…) are a later phase. Extend by
 * adding a {@link ChatToolSpec} here — no other file changes.
 */

import { forgeCommentsTool } from '../../mcp/tools/forge-comments.js';
import { forgeIssuesTool } from '../../mcp/tools/forge-issues.js';
import { forgeKnowledgeTool } from '../../mcp/tools/forge-knowledge.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../mcp/tools/forge-metrics.js';
import { forgePipelineRunsGetTool } from '../../mcp/tools/forge-pipeline-runs.js';
import { forgeProjectPipelineRunsTool } from '../../mcp/tools/forge-project-pipeline-runs.js';
import { forgeProjectsGetTool } from '../../mcp/tools/forge-projects.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { type ChatToolSpec, type ChatToolset, buildToolset } from './mcp-adapter.js';

/** Curated read-only allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  { factory: forgeIssuesTool, readActions: ['list', 'get', 'listTasks'] },
  { factory: forgeCommentsTool, readActions: ['list'] },
  { factory: forgeKnowledgeTool, readActions: ['list', 'get', 'search'] },
  { factory: forgeProjectsGetTool },
  { factory: forgePipelineRunsGetTool },
  { factory: forgeProjectPipelineRunsTool },
  { factory: forgeMetricsProjectStepDurationsTool },
  { factory: forgeMetricsProjectTimeseriesTool },
];

/** Build the read-only OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
