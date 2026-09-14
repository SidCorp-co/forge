/**
 * ISS-604 — the provider-chat tool registry. Mirrors the chat *provider*
 * registry pattern: a curated allowlist over the `forge_*` MCP catalog,
 * resolved per project-context into an OpenAI toolset.
 *
 * ISS-1009: the tracker is reached through the `forge` CLI tool alone; the
 * per-verb `forge_issues` / `forge_comments` wrappers left chat with it.
 * Extend by adding a {@link ChatToolSpec} here — no other file changes.
 */

import { forgeGuideTool } from '../../mcp/tools/forge-guide.js';
import { forgeKnowledgeTool } from '../../mcp/tools/forge-knowledge.js';
import { forgeMemorySearchTool } from '../../mcp/tools/forge-memory.js';
import {
  forgeMetricsProjectStepDurationsTool,
  forgeMetricsProjectTimeseriesTool,
} from '../../mcp/tools/forge-metrics.js';
import { forgePipelineRunsGetTool } from '../../mcp/tools/forge-pipeline-runs.js';
import { forgeProjectPipelineRunsTool } from '../../mcp/tools/forge-project-pipeline-runs.js';
import { forgeProjectsGetTool } from '../../mcp/tools/forge-projects.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { forgeCliTool } from './forge-cli-tool.js';
import { buildToolset, type ChatToolSpec, type ChatToolset } from './mcp-adapter.js';

/** Curated allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  // cm:guard the ONE tracker door: `forge_issues` and `forge_comments` are not offered beside it. Measured 2026-09-15 with both offered, the model reached the wrapper for a status question, a duplicate check and a settings change while the persona named the CLI — two doors to one tracker is which one a model in a hurry takes, and the wrapper knows nothing of `forge new`'s neighbours, fold or shape (ISS-1009).
  { factory: forgeCliTool },
  // cm:guard CLASSIFIED read-only, and the classification is these two action names rather than the tool's own good manners: `forge_guide` also serves `upsert` and `delete`, whose only fence inside the handler is `assertOrgAdmin` — and a chat principal is a signed-in project member who may BE an org admin, so that check would let a room rewrite its org's integration guide. `buildToolset` rejects an action outside this array before the guard and before the handler runs, which is the fence ISS-1005's guard says a new key is unfenced without (ISS-1007).
  { factory: forgeGuideTool, allowedActions: ['list', 'get'] },
  { factory: forgeKnowledgeTool, allowedActions: ['list', 'get', 'search'] },
  { factory: forgeMemorySearchTool },
  { factory: forgeProjectsGetTool },
  { factory: forgePipelineRunsGetTool },
  { factory: forgeProjectPipelineRunsTool },
  { factory: forgeMetricsProjectStepDurationsTool },
  { factory: forgeMetricsProjectTimeseriesTool },
];

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
