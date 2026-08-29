import { Hono } from 'hono';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  type AttentionFailedJobRow,
  type AttentionIssueRow,
  type AttentionMentionRow,
  type AttentionReconcileRow,
  selectAwaitingInput,
  selectFailedJobs,
  selectMentions,
  selectNeedsReview,
  selectPendingSkillUpdates,
  selectUnseenDraftCount,
  selectUnseenDrafts,
} from './attention-buckets.js';

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
  status?: string;
  projectSlug?: string;
  projectName?: string;
}

// cm:edge contract -> packages/web-v2/src/features/attention/types.ts — that file mirrors this response verbatim and says so ("do NOT guess field names"); the two move together or the screen renders a bucket the API stopped sending.
interface AttentionResponse {
  needsReview: AttentionItem[];
  awaitingInput: AttentionItem[];
  mentions: AttentionItem[];
  failedJobs: AttentionItem[];
  pendingSkillUpdates: AttentionItem[];
  unseenDrafts: AttentionItem[];
  /** Unclipped count behind `unseenDrafts`, which is capped. */
  unseenDraftsTotal: number;
  total: number;
}

const issueLink = (slug: string, docId: string) => `/projects/${slug}/issues/${docId}`;

function issueItem(kind: AttentionKind, r: AttentionIssueRow): AttentionItem {
  return {
    kind,
    title: r.title,
    link: issueLink(r.projectSlug, r.id),
    since: r.updatedAt.toISOString(),
    issueRef: `ISS-${r.issSeq}`,
    status: r.status,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

function mentionItem(r: AttentionMentionRow): AttentionItem {
  return {
    kind: 'mention',
    title: r.notificationTitle ?? `Mention in ISS-${r.issSeq}`,
    link: issueLink(r.projectSlug, r.issueDocId),
    since: r.mentionedAt.toISOString(),
    issueRef: `ISS-${r.issSeq}`,
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
}

function failedJobItem(r: AttentionFailedJobRow): AttentionItem {
  const item: AttentionItem = {
    kind: 'failed_job',
    title: r.error ? `${r.type} failed: ${r.error.slice(0, 80)}` : `${r.type} job failed`,
    link: r.issueDocId ? issueLink(r.projectSlug, r.issueDocId) : `/projects/${r.projectSlug}`,
    since: (r.finishedAt ?? r.createdAt).toISOString(),
    status: 'failed',
    projectSlug: r.projectSlug,
    projectName: r.projectName,
  };
  if (r.issSeq != null) item.issueRef = `ISS-${r.issSeq}`;
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

meAttentionRoutes.get('/attention', async (c) => {
  const userId = c.get('userId');

  const [
    needsReviewRows,
    awaitingInputRows,
    mentionRows,
    failedJobRows,
    pendingSkillUpdateRows,
    unseenDraftRows,
    unseenDraftCountRows,
  ] = await Promise.all([
    selectNeedsReview(userId),
    selectAwaitingInput(userId),
    selectMentions(userId),
    selectFailedJobs(userId),
    selectPendingSkillUpdates(userId),
    selectUnseenDrafts(userId),
    selectUnseenDraftCount(userId),
  ]);

  const needsReview = needsReviewRows.map((r) => issueItem('needs_review', r));
  const awaitingInput = awaitingInputRows.map((r) => issueItem('awaiting_input', r));
  const mentions = mentionRows.map(mentionItem);
  const failedJobs = failedJobRows.map(failedJobItem);
  const pendingSkillUpdates = pendingSkillUpdateRows.map(skillUpdateItem);
  const unseenDrafts = unseenDraftRows.map((r) => issueItem('unseen_draft', r));
  const unseenDraftsTotal = Number(unseenDraftCountRows[0]?.total ?? 0);

  // cm:guard `total` counts the ROWS returned, never `unseenDraftsTotal` — the rail badge and the screen both derive from it, and a badge that counts rows the response did not send cannot be reconciled with what the user sees.
  const response: AttentionResponse = {
    needsReview,
    awaitingInput,
    mentions,
    failedJobs,
    pendingSkillUpdates,
    unseenDrafts,
    unseenDraftsTotal,
    total:
      needsReview.length +
      awaitingInput.length +
      mentions.length +
      failedJobs.length +
      pendingSkillUpdates.length +
      unseenDrafts.length,
  };

  return c.json(response);
});
