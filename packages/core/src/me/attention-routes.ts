import type { StuckIssueKind } from '@forge/contracts/notifications';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readStuckKinds, type StuckReason } from '../projects/stuck-kinds-read.js';
import {
  ATTENTION_BUCKETS,
  type AttentionAwaitingRow,
  type AttentionBucket,
  type AttentionFailedJobRow,
  type AttentionIssueRow,
  type AttentionMentionRow,
  type AttentionReconcileRow,
  selectAwaitingInput,
  selectMentions,
  selectNeedsReview,
  selectPendingSkillUpdates,
  selectUnseenDrafts,
} from './attention-buckets.js';
import {
  type StandingFailure,
  selectFailedJobs,
  selectStandingFailures,
} from './attention-failed-jobs.js';
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
  /** Failed-job only: the job a person retries from the row. */
  jobId?: string;
  /** Failed-job only: the kind of work, as stored, which a screen words. */
  jobType?: string;
  /** Failed-job only: the stored cause code a screen words; a sentence the job wrote is the title's alone. */
  failure?: string | null;
  /** The reason a stuck-issue notice tells the item's issue by, where one stands. */
  stuckKind?: StuckIssueKind;
  stuckOwedBy?: string;
  /** Owed answer or review only: the reader's failed job on the issue, which this row names under it. */
  failedJob?: { jobType: string; failure: string | null };
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

function withStuckKind(
  item: AttentionItem,
  issueId: string | null,
  kinds: ReadonlyMap<string, StuckReason>,
): AttentionItem {
  const told = issueId ? kinds.get(issueId) : undefined;
  if (!told) return item;
  return { ...item, stuckKind: told.kind, ...(told.owedBy ? { stuckOwedBy: told.owedBy } : {}) };
}

/** An item owed an answer, naming the reader's failed job on its issue where one stands (ISS-1229 r15). */
function withFailedJob(
  item: AttentionItem,
  issueId: string,
  failures: ReadonlyMap<string, StandingFailure>,
): AttentionItem {
  const job = failures.get(issueId);
  return job ? { ...item, failedJob: { jobType: job.type, failure: failureCode(job) } } : item;
}

/** One lower-case token: the shape a stored cause code has, and a sentence never does. */
const STORED_CODE = /^[a-z][a-z0-9_-]*$/;

/**
 * The cause a person is told, as its stored code: the classifier's where it wrote one, else the job's
 * own error where that is a code. A sentence either wrote is a diagnostic, kept in the title an API
 * caller reads and never handed to a screen to word (ISS-1229 r15).
 */
export function failureCode(
  r: Pick<AttentionFailedJobRow, 'failureReason' | 'error'>,
): string | null {
  for (const said of [r.failureReason, r.error]) {
    const code = said?.trim();
    if (code && STORED_CODE.test(code)) return code;
  }
  return null;
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
    jobId: r.jobId,
    title: r.error ? `${r.type} failed: ${r.error.slice(0, 80)}` : `${r.type} job failed`,
    jobType: r.type,
    failure: failureCode(r),
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
 * The organization the caller has open: every bucket and total is cut to it before its cap. `expand`
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
        message: `orgId must be the uuid of an organization, or left out to read every one; expand names buckets to list whole, each one of ${ATTENTION_BUCKETS.join(', ')}`,
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

    const owedIds = [...needsReviewRows.map((r) => r.id), ...awaitingInputRows.map((r) => r.id)];
    const [kinds, failures] = await Promise.all([
      readStuckKinds(
        [...owedIds, ...failedJobRows.flatMap((r) => (r.issueDocId ? [r.issueDocId] : []))],
        userId,
      ),
      selectStandingFailures(userId, owedIds),
    ]);
    const needsReview = needsReviewRows.map((r) =>
      withFailedJob(withStuckKind(issueItem('needs_review', r), r.id, kinds), r.id, failures),
    );
    const awaitingInput = awaitingInputRows.map((r) =>
      withFailedJob(withStuckKind(awaitingItem(r), r.id, kinds), r.id, failures),
    );
    const mentions = mentionRows.map(mentionItem);
    const failedJobs = failedJobRows.map((r) =>
      withStuckKind(failedJobItem(r), r.issueDocId, kinds),
    );
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
