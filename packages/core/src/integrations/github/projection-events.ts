import { db } from '../../db/client.js';
import { recordIssueMerge } from '../../issues/merge-record.js';
import { logger } from '../../logger.js';
import { hooks } from '../../pipeline/hooks.js';
import { forgetLiveReading } from '../../projects/live-reading.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
import { publishForStoredPullRequest } from './contract-check.js';
import { resolveIssueForHeadRef } from './issue-link.js';
import {
  applyCheckRunEvent,
  applyPullRequestEvent,
  applyReviewEvent,
  branchOfPush,
  type CheckRunPayload,
  findRowByNumber,
  openPullRequestsOnBase,
  type ProjectionContext,
  type PullRequestPayload,
  type PushPayload,
  type ReviewPayload,
  stateOf,
} from './projection.js';
import {
  BASE_PUSH_REFRESH_CAP,
  markRefreshCapped,
  refreshStoredPullRequest,
  storeRefreshRefusal,
} from './projection-refresh.js';
import { noteReviewOnIssue } from './review-note.js';
import { applyWorkflowRunEvent, type WorkflowRunPayload } from './runner-release-events.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/** The events this projection is built from. Anything else falls through. */
export const PROJECTED_EVENTS = [
  'pull_request',
  'check_run',
  'pull_request_review',
  'push',
  'workflow_run',
] as const;

export type ProjectedEvent = (typeof PROJECTED_EVENTS)[number];

export function isProjectedEvent(eventType: string): eventType is ProjectedEvent {
  return (PROJECTED_EVENTS as readonly string[]).includes(eventType);
}

/** What a delivery brings with it: its own binding, config and credential. */
export interface DeliveryContext extends ProjectionContext {
  config: GitHubConfig;
  secrets: GitHubSecrets;
}

/** A client, or the sentence an operator acts on. Never an exception either way. */
type ClientOrRefusal = { client: GitHubRepoClient } | { client: null; reason: string };

function clientFor(ctx: DeliveryContext): ClientOrRefusal {
  try {
    return {
      client: buildRepoClient({
        bindingId: ctx.bindingId,
        config: ctx.config,
        secrets: ctx.secrets,
      }),
    };
  } catch (err) {
    if (err instanceof GitHubClientError) {
      logger.info(
        { bindingId: ctx.bindingId, reason: err.reason },
        'repo projection: no App client for this binding, so nothing is re-read',
      );
      return { client: null, reason: err.message };
    }
    throw err;
  }
}

const REFRESHING_PR_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'edited',
  'ready_for_review',
]);

/**
 * Record a merge a person made, on the same row the kernel's own merge writes.
 *
 * ISS-1073's outcome 3. Somebody pressing Merge on GitHub and Forge merging
 * through `merge.ts` are one landing arriving by two routes, and they produce
 * ONE record because both write through `issues/merge-record.ts` under
 * `merged_commit_sha IS NULL` — whichever gets there first holds the row, and
 * the second reads it back rather than overwriting it.
 */
async function stampMergedIssue(ctx: DeliveryContext, payload: PullRequestPayload): Promise<void> {
  const pr = payload.pull_request;
  if (!pr || stateOf(pr) !== 'merged') return;
  const commitSha = pr.merge_commit_sha;
  const mergedAt = pr.merged_at ? new Date(pr.merged_at) : null;
  if (!commitSha || !mergedAt || Number.isNaN(mergedAt.getTime())) return;
  const headRef = pr.head?.ref;
  if (!headRef) return;
  const issueId = await resolveIssueForHeadRef({ projectId: ctx.projectId, headRef });
  if (!issueId) return;
  const record = await recordIssueMerge(db, {
    issueId,
    evidence: { kind: 'observed', commitSha, mergedAt, via: 'event' },
  });
  if (!record.wrote) return;
  try {
    await hooks.emit('contractInputChanged', {
      projectId: ctx.projectId,
      issueId,
      reason: 'merged on GitHub',
    });
  } catch (err) {
    logger.warn({ err, issueId }, 'repo projection: announcing the merge failed');
  }
}

async function onPullRequest(ctx: DeliveryContext, payload: PullRequestPayload): Promise<number> {
  const written = await applyPullRequestEvent(ctx, payload);
  await stampMergedIssue(ctx, payload);
  if (written === 0) return 0;
  if (!REFRESHING_PR_ACTIONS.has(payload.action ?? '')) return written;
  const number = payload.pull_request?.number;
  if (typeof number !== 'number') return written;
  const row = await findRowByNumber(ctx, number);
  if (!row) return written;
  const got = clientFor(ctx);
  if (got.client) await refreshStoredPullRequest(got.client, row.id);
  else await storeRefreshRefusal([row], got.reason);
  await publishForStoredPullRequest(row.id);
  return written;
}

async function onPush(ctx: DeliveryContext, payload: PushPayload): Promise<number> {
  forgetLiveReading(ctx.projectId);
  const branch = branchOfPush(payload);
  if (!branch) return 0;
  const rows = await openPullRequestsOnBase(ctx, branch);
  if (rows.length === 0) return 0;
  const got = clientFor(ctx);
  if (!got.client) return storeRefreshRefusal(rows, got.reason);
  let touched = 0;
  for (const row of rows.slice(0, BASE_PUSH_REFRESH_CAP)) {
    if (await refreshStoredPullRequest(got.client, row.id)) touched += 1;
  }
  touched += await markRefreshCapped(rows.slice(BASE_PUSH_REFRESH_CAP).map((r) => r.id));
  return touched;
}

/**
 * Store the review, and write it onto the issue its head branch names.
 *
 * The two halves answer different questions and neither replaces the other: the projection holds
 * every review still standing on a pull request, which is state a master reads; the comment is the
 * REVIEW THREAD, and ISS-1074's rule is that there is one of those whichever side wrote into it.
 */
async function onReview(ctx: DeliveryContext, payload: ReviewPayload): Promise<number> {
  const written = await applyReviewEvent(ctx, payload);
  const review = payload.review;
  const headRef = payload.pull_request?.head?.ref;
  const number = payload.pull_request?.number;
  if (payload.action === 'dismissed' || !review?.id || !headRef || typeof number !== 'number') {
    return written;
  }
  const noted = await noteReviewOnIssue({
    projectId: ctx.projectId,
    headRef,
    repository: `${ctx.config.owner ?? ''}/${ctx.config.repo ?? ''}`,
    number,
    review: {
      id: String(review.id),
      reviewer: review.user?.login ?? '(unknown)',
      state: (review.state ?? 'commented').toLowerCase(),
      submittedAt: review.submitted_at ?? null,
      url: review.html_url ?? null,
      body: review.body ?? null,
    },
  });
  return noted.outcome === 'written' ? written + 1 : written;
}

/** Apply one delivery to the projection, and report how many rows it moved. */
export async function applyProjectedEvent(
  ctx: DeliveryContext,
  eventType: ProjectedEvent,
  payload: unknown,
): Promise<number> {
  switch (eventType) {
    case 'pull_request':
      return onPullRequest(ctx, payload as PullRequestPayload);
    case 'check_run':
      return applyCheckRunEvent(ctx, payload as CheckRunPayload);
    case 'pull_request_review':
      return onReview(ctx, payload as ReviewPayload);
    case 'push':
      return onPush(ctx, payload as PushPayload);
    case 'workflow_run':
      return applyWorkflowRunEvent(ctx, payload as WorkflowRunPayload);
  }
}
