import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  ATTENTION_BUCKETS,
  type AttentionAwaitingRow,
  type AttentionBucket,
  type AttentionFailedJobRow,
  type AttentionIssueRow,
  type AttentionMentionRow,
  type AttentionReconcileRow,
  selectAwaitingInput,
  selectFailedJobs,
  selectMentions,
  selectNeedsReview,
  selectPendingSkillUpdates,
  selectUnseenDrafts,
} from './attention-buckets.js';
import { attentionSchema, readAttention } from './attention-routes-reference.js';
import {
  type AttentionProjectTotals,
  selectAttentionTotals,
  selectBucketTotals,
} from './attention-totals.js';

type AttentionKind =
  | 'needs_review'
  | 'awaiting_input'
  | 'mention'
  | 'failed_job'
  | 'pending_skill_update'
  | 'unseen_draft';

interface AttentionItem {
  kind: AttentionKind;
  title: string;
  link: string;
  since: string;
  issueRef?: string;
  /** Failed-job only: the title of the issue the job ran for, where it ran for one. */
  issueTitle?: string;
  /** Failed-job only: the kind of work, as stored, which a screen words. */
  jobType?: string;
  /** Failed-job only: what the classifier named, else the job's own error; a screen words a known cause. */
  failure?: string | null;
  status?: string;
  projectSlug?: string;
  projectName?: string;
  /** Awaiting-input only: who can end the wait, and what it costs meanwhile. */
  blockerKind?: string | null;
  questionId?: string | null;
  cost?: { claimsHeld: number; workspacesPinned: number; dependents: number };
}

interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  pendingSkillUpdates: AttentionItem[];
  unseenDrafts: AttentionItem[];
  /** Unclipped count behind `unseenDrafts`, which is capped. */
  unseenDraftsTotal: number;
  /** Each bucket counted whole before its cap: what a screen says however many rows it lists. */
  bucketTotals: Record<AttentionBucket, number>;
  /** Per project slug, the whole counts the project's Needs you list is made of. */
  projectTotals: Record<string, AttentionProjectTotals>;
  /** Every item the buckets hold, listed or not: the buckets' whole counts summed. */
  total: number;
}

const issueLink = (slug: string, docId: string) => `/projects/${slug}/issues/${docId}`;

function issueItem(kind: AttentionKind, r: AttentionIssueRow): AttentionItem {
  return {
    kind,
    title: r.title,
    link: issueLink(r.projectSlug, r.id),
    since: r.statusEnteredAt.toISOString(),
    issueRef: formatIssueRef(r.issuePrefix, r.issSeq),
    status: r.status,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

function awaitingItem(r: AttentionAwaitingRow): AttentionItem {
  return {
    ...issueItem('awaiting_input', r),
    since: r.waitingSince.toISOString(),
    blockerKind: r.blockerKind,
    questionId: r.questionId,
    cost: {
      claimsHeld: r.claimsHeld,
      workspacesPinned: r.workspacesPinned,
      dependents: r.dependents,
    },
  };
}

function mentionItem(r: AttentionMentionRow): AttentionItem {
  return {
    kind: 'mention',
    title: r.notificationTitle ?? `Mention in ${formatIssueRef(r.issuePrefix, r.issSeq)}`,
    link: issueLink(r.projectSlug, r.issueDocId),
    since: r.mentionedAt.toISOString(),
    issueRef: formatIssueRef(r.issuePrefix, r.issSeq),
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

function failedJobItem(r: AttentionFailedJobRow): AttentionItem {
  const item: AttentionItem = {
    kind: 'failed_job',
    title: r.error ? `${r.type} failed: ${r.error.slice(0, 80)}` : `${r.type} job failed`,
    jobType: r.type,
    failure: r.failureReason ?? r.error,
    link: r.issueDocId ? issueLink(r.projectSlug, r.issueDocId) : `/projects/${r.projectSlug}`,
    since: (r.finishedAt ?? r.createdAt).toISOString(),
    status: 'failed',
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
  if (r.issSeq != null) item.issueRef = formatIssueRef(r.issuePrefix, r.issSeq);
  if (r.issueTitle != null) item.issueTitle = r.issueTitle;
  return item;
}

function skillUpdateItem(r: AttentionReconcileRow): AttentionItem {
  return {
    kind: 'pending_skill_update',
    title: 'Skill update pending',
    link: `/projects/${r.projectSlug}/library?tab=updates`,
    since: (r.decidedAt ?? r.createdAt).toISOString(),
    status: r.status,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

export const meAttentionRoutes = new Hono<{ Variables: AuthVars }>();
meAttentionRoutes.use('/attention', requireAuth(), assertEmailVerified());

/**
 * The organisation the caller has open: every bucket and total is cut to it before its cap. `expand`
 * names the buckets to list whole rather than capped, so a person can reach every item a count names
 * without answering the ones above it first (ISS-1229 r14).
 */
const attentionQuerySchema = z.object({
  orgId: z.uuid().optional(),
  expand: z
    .union([z.enum(ATTENTION_BUCKETS), z.array(z.enum(ATTENTION_BUCKETS))])
    .optional()
    .transform((v) => new Set<AttentionBucket>(v === undefined ? [] : Array.isArray(v) ? v : [v])),
});

meAttentionRoutes.get(
  '/attention',
  readAttention,
  zValidator('query', attentionQuerySchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: `orgId must be the uuid of an organisation, or left out to read every one; expand names buckets to list whole, each one of ${ATTENTION_BUCKETS.join(', ')}`,
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const userId = c.get('userId');
    const { orgId, expand } = c.req.valid('query');
    const scope = { orgId };
    const whole = (bucket: AttentionBucket) => (expand.has(bucket) ? null : undefined);

    const [
      needsReviewRows,
      awaitingInputRows,
      mentionRows,
      failedJobRows,
      pendingSkillUpdateRows,
      unseenDraftRows,
      bucketTotals,
      projectTotals,
    ] = await Promise.all([
      selectNeedsReview(userId, scope, whole('needsReview')),
      selectAwaitingInput(userId, scope, whole('awaitingInput')),
      selectMentions(userId, scope, whole('mentions')),
      selectFailedJobs(userId, scope, whole('failedJobs')),
      selectPendingSkillUpdates(userId, scope, whole('pendingSkillUpdates')),
      selectUnseenDrafts(userId, scope, whole('unseenDrafts')),
      selectBucketTotals(userId, scope),
      selectAttentionTotals(userId, scope),
    ]);

    const needsReview = needsReviewRows.map((r) => issueItem('needs_review', r));
    const awaitingInput = awaitingInputRows.map(awaitingItem);
    const mentions = mentionRows.map(mentionItem);
    const failedJobs = failedJobRows.map(failedJobItem);
    const pendingSkillUpdates = pendingSkillUpdateRows.map(skillUpdateItem);
    const unseenDrafts = unseenDraftRows.map((r) => issueItem('unseen_draft', r));

    const response: AttentionResponse = {
      needsReview,
      awaitingInput,
      mentions,
      failedJobs,
      pendingSkillUpdates,
      unseenDrafts,
      unseenDraftsTotal: bucketTotals.unseenDrafts,
      bucketTotals,
      projectTotals,
      total: ATTENTION_BUCKETS.reduce((n, b) => n + bucketTotals[b], 0),
    };

    return c.json(answer(attentionSchema, response));
  },
);
