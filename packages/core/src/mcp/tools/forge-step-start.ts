import { z } from 'zod';
import { extractIssueBranchOverride, resolveIssueBranches } from '../../branches/resolve.js';
import { listCommentAttachmentsForIssue } from '../../comments/attachment-service.js';
import { listIssueComments } from '../../comments/service.js';
import type { JobType } from '../../db/schema.js';
import { jobTypes } from '../../db/schema.js';
import { getIssueContexts } from '../../pipeline/issue-context-store.js';
import { readProjectBranches } from '../../projects/service.js';
import {
  heavyFieldChars,
  type IssueRow,
  loadIssue,
  serializeManifestWithAttachments,
  serializeWithAttachments,
} from './forge-issues.js';
import type { ContextScopedMcpToolFactory } from './lib.js';
import { assertPrincipalIsWriter, zodToMcpSchema } from './lib.js';

/**
 * `forge_step_start` — the check-in an agent makes as its FIRST action on an
 * issue. One call replaces the fetch boilerplate at the head of a step:
 * issue get + comments list + handoff get + branch resolution.
 *
 * It used to also flip the issue to the step's in-flight status. That flip
 * read the staged lane's step table and went with it (ISS-895); this tool is
 * now read-only on status and says so in `statusNote` on every call.
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

// cm:why past this many chars of heavy fields, one complex issue would dominate the agent's context window on every step call, so step_start returns a lean manifest and lets the agent pull what it needs; under it, the full body still arrives in one round-trip.
const STEP_START_BODY_MANIFEST_THRESHOLD = 2000;

const inputSchema = z
  .object({
    projectId: z.uuid(),
    issueId: z.uuid(),
    /** The step checking in. Required — nothing derives it from a status any more. */
    stage: z.enum(jobTypes).optional(),
  })
  .strict();

// cm:guard the step can no longer be DERIVED, and the caller must not be handed a guess. ISS-895 removed `STATUS_TO_JOB_TYPE` with the staged lane, so there is no status→step map left to read; the only lane this pipeline has dispatches `drive`, whose whole walk is one step. Defaulting to `drive` when `stage` is absent would label every check-in as the driver's, including a caller that meant something else.
function resolveStage(input: { stage?: JobType | undefined }): JobType {
  if (input.stage) return input.stage;
  throw new Error(
    'BAD_REQUEST: `stage` is required — the staged lane was removed (ISS-895), so no issue status maps to a step any more',
  );
}

export const forgeStepStartTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_step_start',
  description:
    "Check in at the start of work on an issue. Never moves the issue — pass `stage` and it returns the working bundle: the issue (with `attachments[]`), the most-recent comments, the latest step handoffs, and the resolved `branchConfig` (issue override layered over project defaults — null means NOT configured; never fall back to main). The comment thread is capped to the most-recent N (oldest trimmed first) plus a hard char budget so the bundle stays under the MCP output cap; when trimmed the result carries `commentsTruncated:true` + `commentsReturned`/`commentsTotal` + a notice — fetch the full history via `forge_comments.list`. The issue body is threshold-gated: when the total size of heavy fields (description/plan/acceptanceCriteria/sessionContext) exceeds the threshold, the issue carries `bodyTruncated:true` and a `bodyManifest` (field → {chars} | null) instead of the full bodies — pull only the fields you need via `forge_issues.get { documentId, fields: ['plan', ...] }`. Small issues (under threshold) return the full body with no extra round-trip. Handoffs, branchConfig, and light scalars are never truncated. Idempotent and read-only on status — safe to re-call on resume. Call this FIRST, before any other action on the issue.",
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    await assertPrincipalIsWriter(ctx.principal, input.projectId);

    const issue: IssueRow = await loadIssue(input.issueId);
    if (issue.projectId !== input.projectId) {
      throw new Error('NOT_FOUND: issue not found in project');
    }

    const stage = resolveStage(input);

    // cm:guard this tool NEVER moves the issue any more, and the note says so on every call rather than going quiet. The trigger→working flip it used to perform belonged to the staged lane's step table (ISS-895); the driver owns its own status writes, and a silent `statusChanged:false` would read to an agent as "already there" rather than "this no longer happens".
    const statusChanged = false;
    const statusNote = `no status flip: the staged lane was removed (ISS-895), so no step has an in-flight status — the driver writes its own status. Issue is at '${issue.status}'.`;

    const [commentRows, commentAttachmentsByCommentId, handoffs, projectRow] = await Promise.all([
      listIssueComments(input.issueId),
      listCommentAttachmentsForIssue(input.issueId),
      getIssueContexts({
        projectId: input.projectId,
        issueId: input.issueId,
        kind: 'handoff',
        limit: 5,
        orderDir: 'desc',
      }),
      readProjectBranches(input.projectId),
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

    const allComments = commentRows.map(
      ({ id, issueId: _issueId, updatedAt: _updatedAt, ...c }) => ({
        documentId: id,
        ...c,
        attachments: commentAttachmentsByCommentId.get(id) ?? [],
      }),
    );
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

    const heavyChars = heavyFieldChars(issue);
    const issuePayload =
      heavyChars > STEP_START_BODY_MANIFEST_THRESHOLD
        ? await serializeManifestWithAttachments(issue)
        : await serializeWithAttachments(issue);

    return {
      stage,
      statusChanged,
      ...(statusNote ? { statusNote } : {}),
      issue: issuePayload,
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
