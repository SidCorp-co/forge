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
import { resolveIssueDisplayId } from './issue-ref.js';
import { buildToolset, type ChatToolSpec, type ChatToolset } from './mcp-adapter.js';

/**
 * ISS-687 — wrap the pure `guardIssueWrites` (draft-force + thin-issue floor)
 * with the create-path dedup check. Fires on BOTH Bao's direct create and a
 * PM-proposed create (both flow through this one spec) — a near-duplicate
 * draft/open issue is rejected with tool-error feedback so the model comments
 * on the existing one instead of filing a repeat.
 */
// cm:guard the floor is recall-first on purpose and this key is the only way back — the title score is Jaccard word overlap, which cannot separate a real repeat (measured 0.727 on 2026-09-04) from two issues about different pages ("Dark mode broken on the settings page" vs "…profile page" scores 0.750), so the guard refuses both; without an override every false positive is unrecoverable inside the turn, because the model cannot restate its way past a deterministic check
const DEDUP_OVERRIDE_KEY = 'confirmNotDuplicate';

async function guardIssueWritesDeduped(
  args: Record<string, unknown>,
  ctx?: { projectId: string | null },
): Promise<string | null> {
  const rejection = guardIssueWrites(args);
  if (rejection) return rejection;
  if (ctx?.projectId) {
    const unknownRef = await resolveIssueDisplayId(db, ctx.projectId, args);
    if (unknownRef) return unknownRef;
  }
  if (args.action === 'create' && ctx?.projectId) {
    const data = (args.data ?? {}) as Record<string, unknown>;
    // cm:guard consumed here, never forwarded — `forge_issues` validates `data` strictly, so leaving the flag on it turns an override into a 400
    const overridden = data[DEDUP_OVERRIDE_KEY] === true;
    delete data[DEDUP_OVERRIDE_KEY];
    const title = typeof data.title === 'string' ? data.title : '';
    const description = typeof data.description === 'string' ? data.description : '';
    const duplicate = await findDuplicateIssue(db, {
      projectId: ctx.projectId,
      title,
      description,
    });
    if (duplicate && !overridden) {
      return `a near-duplicate issue already exists (ISS-${duplicate.issSeq}: "${duplicate.title}", status draft/open) — comment on it via forge_comments instead of creating a new one. The check is word overlap, not meaning: when this is genuinely a different issue (two screens, two releases, two customers), re-send the same create with \`data.${DEDUP_OVERRIDE_KEY}: true\`.`;
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
    describe: '`documentId` also accepts the short `ISS-<n>` id shown as `issueId`.',
  },
  { factory: forgeCommentsTool, allowedActions: ['list', 'create'] },
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
