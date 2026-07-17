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

import { db } from '../../db/client.js';
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
import { forgeProjectsGetTool } from '../../mcp/tools/forge-projects.js';
import type { McpContext } from '../../mcp/tools/lib.js';
import { guardIssueWrites } from './guards.js';
import { findDuplicateIssue } from './issue-dedup.js';
import { type ChatToolSpec, type ChatToolset, buildToolset } from './mcp-adapter.js';

/**
 * ISS-687 — wrap the pure `guardIssueWrites` (draft-force + thin-issue floor)
 * with the create-path dedup check. Fires on BOTH Bao's direct create and a
 * PM-proposed create (both flow through this one spec) — a near-duplicate
 * draft/open issue is rejected with tool-error feedback so the model comments
 * on the existing one instead of filing a repeat.
 */
async function guardIssueWritesDeduped(
  args: Record<string, unknown>,
  ctx?: { projectId: string | null },
): Promise<string | null> {
  const rejection = guardIssueWrites(args);
  if (rejection) return rejection;
  if (args.action === 'create' && ctx?.projectId) {
    const data = (args.data ?? {}) as Record<string, unknown>;
    const title = typeof data.title === 'string' ? data.title : '';
    const description = typeof data.description === 'string' ? data.description : '';
    const duplicate = await findDuplicateIssue(db, {
      projectId: ctx.projectId,
      title,
      description,
    });
    if (duplicate) {
      return `a near-duplicate issue already exists (ISS-${duplicate.issSeq}: "${duplicate.title}", status draft/open) — comment on it via forge_comments instead of creating a new one`;
    }
  }
  return null;
}

/** Curated allowlist exposed to the chat model. */
export const CHAT_TOOL_ALLOWLIST: ChatToolSpec[] = [
  {
    factory: forgeIssuesTool,
    allowedActions: ['list', 'get', 'listTasks', 'create', 'update'],
    guard: guardIssueWritesDeduped,
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
];

/** Build the OpenAI toolset for a project-scoped chat context. */
export function buildProjectToolset(ctx: McpContext): ChatToolset {
  return buildToolset(ctx, CHAT_TOOL_ALLOWLIST);
}
