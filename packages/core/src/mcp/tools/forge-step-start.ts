import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import { listCommentAttachmentsForIssue } from '../../comments/attachment-service.js';
import { db } from '../../db/client.js';
import { type IssueStatus, type JobType, comments, jobTypes, projects } from '../../db/schema.js';
import { applyStatusTransition } from '../../issues/apply-transition.js';
import { getIssueContexts } from '../../pipeline/issue-context-store.js';
import {
  STATUS_TO_JOB_TYPE,
  TRIGGER_STATUS_BY_JOB_TYPE,
  WORKING_STATUS_BY_JOB_TYPE,
} from '../../pipeline/registry.js';
import { type IssueRow, loadIssue, serializeWithAttachments } from './forge-issues.js';
import { assertPrincipalIsMember, assertPrincipalIsWriter, zodToMcpSchema } from './lib.js';
import type { ContextScopedMcpToolFactory } from './lib.js';

/**
 * `forge_step_start` — the check-in an agent makes as its FIRST action on a
 * pipeline step. One call replaces the fetch boilerplate at the head of every
 * step (issue get + comments list + handoff get + branch resolution) and
 * flips the issue to the step's in-flight status when the registry defines
 * one (`PIPELINE_STEPS.workingStatus`, sparse — code/fix → `in_progress`).
 *
 * Agent-initiated by design: core never stamps the working status itself —
 * the agent owns its status updates (prompt-layer discipline), this tool just
 * makes the correct first move atomic and cheap.
 *
 * Idempotent: re-running on an issue already at the working status (resume,
 * duplicate call) changes nothing and still returns a fresh bundle. The flip
 * is guarded to the trigger→working edge only, so an issue an operator moved
 * to `needs_info`/`on_hold` is never stomped.
 */

/**
 * Bound the comment thread so the bundle never overflows the MCP output cap on
 * a long AI-comment history (it spills to file / bloats agent context). Mirrors
 * the `forge-jobs.ts` MAX_RESPONSE_CHARS precedent: keep the most-recent N and a
 * hard char budget, trimming OLDEST first (comments are returned oldest→newest,
 * so the latest review/clarify/plan context is always kept). The issue body,
 * handoffs, and branchConfig are NEVER trimmed; full history via
 * `forge_comments.list`.
 */
const STEP_START_RECENT_COMMENTS = 20;
const STEP_START_COMMENTS_MAX_CHARS = 30_000;

const inputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid(),
    /**
     * The step checking in. Optional — when omitted it is derived from the
     * issue's current trigger status; required when the issue is at a
     * non-trigger status (e.g. resuming at `in_progress`, the shared working
     * status of both code and fix, so the step can't be inferred).
     */
    stage: z.enum(jobTypes).optional(),
  })
  .strict();

function resolveStage(input: { stage?: JobType | undefined }, status: IssueStatus): JobType {
  if (input.stage) return input.stage;
  const mapped = STATUS_TO_JOB_TYPE[status]?.type;
  if (mapped) return mapped;
  throw new Error(
    `BAD_REQUEST: cannot derive the step from issue status '${status}' — pass \`stage\` explicitly`,
  );
}

export const forgeStepStartTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_step_start',
  description:
    "Check in at the start of a pipeline step. Marks the issue with the step's in-flight status when one is defined (code/fix → `in_progress`; other steps keep their trigger status) and returns the working bundle: the full issue body, the most-recent comments, the latest step handoffs, and the resolved `branchConfig` (issue override layered over project defaults — null means NOT configured; never fall back to main). The comment thread is capped to the most-recent N (oldest trimmed first) plus a hard char budget so the bundle stays under the MCP output cap; when trimmed the result carries `commentsTruncated:true` + `commentsReturned`/`commentsTotal` + a notice — fetch the full history via `forge_comments.list`. The issue body, handoffs, and branchConfig are never trimmed. Idempotent — safe to re-call on resume; it never moves an issue that is not sitting at the step's trigger status. Call this FIRST, before any other action on the issue.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPrincipalIsWriter(ctx.principal, input.projectId);

    const issue: IssueRow = await loadIssue(input.issueId);
    if (issue.projectId !== input.projectId) {
      throw new Error('NOT_FOUND: issue not found in project');
    }

    const stage = resolveStage(input, issue.status);
    const workingStatus = WORKING_STATUS_BY_JOB_TYPE[stage] ?? null;
    const triggerStatus = TRIGGER_STATUS_BY_JOB_TYPE[stage] ?? null;

    let statusChanged = false;
    let statusNote: string | null = null;
    if (workingStatus === null) {
      statusNote = `step '${stage}' has no in-flight status — '${issue.status}' already signals it`;
    } else if (issue.status === workingStatus) {
      statusNote = `already at '${workingStatus}' (resume / duplicate check-in)`;
    } else if (issue.status === triggerStatus) {
      await applyStatusTransition(issue, workingStatus, ctx.device);
      issue.status = workingStatus;
      statusChanged = true;
    } else {
      statusNote = `not flipped: issue is at '${issue.status}', not the '${stage}' trigger '${triggerStatus}'`;
    }

    const [commentRows, commentAttachmentsByCommentId, handoffs, [projectRow]] = await Promise.all([
      db
        .select({
          documentId: comments.id,
          authorId: comments.authorId,
          body: comments.body,
          parentId: comments.parentId,
          createdAt: comments.createdAt,
        })
        .from(comments)
        .where(eq(comments.issueId, input.issueId))
        .orderBy(asc(comments.createdAt)),
      listCommentAttachmentsForIssue(input.issueId),
      getIssueContexts({
        projectId: input.projectId,
        issueId: input.issueId,
        kind: 'handoff',
        limit: 5,
        orderDir: 'desc',
      }),
      db
        .select({
          baseBranch: projects.baseBranch,
          productionBranch: projects.productionBranch,
        })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1),
    ]);

    // Mirror forge_config's issue-aware branch resolution (metadata override,
    // falling back to sessionContext until the real issues.metadata column
    // lands — see ISS PR-C).
    const branchOverride = extractIssueBranchOverride(
      issue as unknown as Parameters<typeof extractIssueBranchOverride>[0],
    );
    const branchConfig = resolveIssueBranches(
      { metadata: { branchConfig: branchOverride } },
      {
        baseBranch: projectRow?.baseBranch ?? null,
        productionBranch: projectRow?.productionBranch ?? null,
      },
    );

    const allComments = commentRows.map((c) => ({
      ...c,
      attachments: commentAttachmentsByCommentId.get(c.documentId) ?? [],
    }));
    const commentsTotal = allComments.length;
    // Keep the most-recent N, then trim oldest-first until the serialized
    // comments fit the char budget — always keep ≥1 when any exist.
    let boundedComments = allComments.slice(-STEP_START_RECENT_COMMENTS);
    while (
      boundedComments.length > 1 &&
      JSON.stringify(boundedComments).length > STEP_START_COMMENTS_MAX_CHARS
    ) {
      boundedComments = boundedComments.slice(1);
    }
    const commentsTruncated = boundedComments.length < commentsTotal;

    return {
      stage,
      statusChanged,
      ...(statusNote ? { statusNote } : {}),
      issue: await serializeWithAttachments(issue),
      comments: boundedComments,
      ...(commentsTruncated
        ? {
            commentsTruncated: true,
            commentsReturned: boundedComments.length,
            commentsTotal,
            commentsNotice: `Showing the ${boundedComments.length} most recent of ${commentsTotal} comments to stay under the MCP output cap. Fetch the full thread via forge_comments.list (filters.issue=<issueId>).`,
          }
        : {}),
      handoffs,
      branchConfig,
    };
  },
});
