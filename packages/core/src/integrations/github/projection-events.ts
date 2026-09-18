/**
 * Which of the four events writes what, and what each one then re-reads.
 *
 * The routing lives here rather than in `webhooks/github-adapter.ts` because
 * that file is the intake door an outside contributor's report enters by
 * (ISS-1076 replaced the GitHub Issues mirror it used to be) and has no other
 * reason to know a pull request exists; and rather than in `projection.ts`,
 * which is deliberately payload-only and holds no credential.
 */

import { db } from '../../db/client.js';
import { recordIssueMerge } from '../../issues/merge-record.js';
import { logger } from '../../logger.js';
import { hooks } from '../../pipeline/hooks.js';
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
import type { GitHubConfig, GitHubSecrets } from './types.js';

/** The events this projection is built from. Anything else falls through. */
export const PROJECTED_EVENTS = [
  'pull_request',
  'check_run',
  'pull_request_review',
  'push',
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

// cm:guard the refresh is BEST EFFORT and its absence is on the row, never in an exception — this runs after the payload write has committed, so throwing would answer the delivery 500 and have GitHub re-deliver a payload in order to retry a read.
// cm:guard the refusal is CARRIED, not swallowed into a log line and a bare null. A binding with no installation or no App key is the commonest reason a refresh never happens and the one an operator can fix, and a row whose counts are null with nothing beside them says "nobody has asked yet" and "Forge cannot ask" in the same breath.
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

// cm:why these four actions are the ones that move a head, a base or the set of commits under review; `labeled`, `assigned` and the rest change nothing the projection holds that the upsert has not already taken from the payload.
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
// cm:guard the evidence comes from the PAYLOAD and not from the projection row this delivery just wrote. They agree today, and reading the payload is what keeps that true: a row whose scalars were skipped by the out-of-order guard (`setWhere` on `payloadIsNotOlder`) holds an older merge state, and stamping an issue from it would record whichever delivery lost the ordering race.
// cm:guard an issue this branch names nothing for is not an error and writes nothing. A pull request whose branch resolves to no issue is an ordinary pull request this repository has, and the projection holds it either way (`issue-link.ts`).
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
  // cm:guard announced only when THIS delivery wrote, so the kernel's merge and the event that follows it do not republish the same change twice. `merge.ts` announces its own.
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
  // cm:guard the stamp runs whatever the projection wrote, and BEFORE the early return below. `applyPullRequestEvent` answers 0 for a payload it could not build a row from and for one the ordering guard skipped, and neither of those is a reason to lose a merge: the issue's stamp is keyed on the head branch and the payload, not on the row.
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
  // cm:guard the contract check is published from THIS arm and from no other. A `check_run` delivery must never reach it: Forge's own run comes back through that door, so publishing there is a loop that re-publishes on its own echo forever — and a check run changes nothing the tracker's contract answers, so there is nothing to recompute either way. A `push` does not reach it because a push moves a BASE, and the criteria are about the issue's record rather than about what the head is behind by.
  await publishForStoredPullRequest(row.id);
  return written;
}

async function onPush(ctx: DeliveryContext, payload: PushPayload): Promise<number> {
  const branch = branchOfPush(payload);
  if (!branch) return 0;
  const rows = await openPullRequestsOnBase(ctx, branch);
  if (rows.length === 0) return 0;
  const got = clientFor(ctx);
  // cm:guard the refusal reaches EVERY row this push invalidated, not the first 25 — the cap bounds the READS, and a row nobody could read for is in the same state as a row past the cap.
  if (!got.client) return storeRefreshRefusal(rows, got.reason);
  // cm:guard `slice` past the cap takes ALL the remainder. Reading `cap + 1` rows and marking the one extra was the shape this replaced: on a base with 27 open pull requests it left two of them stale with no sentence on them, which is the silent truncation the cap's own message exists to prevent.
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
// cm:guard the note is written for a SUBMISSION and not for a dismissal. A dismissal retracts a review GitHub already delivered, and the comment recording that the review was submitted stays true — a second comment saying it was withdrawn would be a second record of one event, which is the thing this write-back exists to stop. The retraction is in the projection, where `dismissed` is a flag beside the state.
// cm:guard the note runs even when the projection wrote NOTHING. `applyReviewEvent` answers 0 for a pull request it holds no row for, and that is exactly the case the tracker record is most needed in: deliveries are unordered, so a review can reach Forge before the `pull_request` event that would have created the row.
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
  }
}
