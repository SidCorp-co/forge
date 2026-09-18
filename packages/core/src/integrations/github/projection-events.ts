/**
 * Which of the four events writes what, and what each one then re-reads.
 *
 * The routing lives here rather than in `webhooks/github-adapter.ts` because
 * that file is the intake door an outside contributor's report enters by
 * (ISS-1076 replaced the GitHub Issues mirror it used to be) and has no other
 * reason to know a pull request exists; and rather than in `projection.ts`,
 * which is deliberately payload-only and holds no credential.
 */

import { logger } from '../../logger.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
import { publishForStoredPullRequest } from './contract-check.js';
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

// cm:guard `workflow_run` is here for the runner release (ISS-1075) and carries no projection of its own: it writes `runner_releases` and touches no `repo_pull_requests` row. It is on this list rather than on a door of its own because this is where a delivery is resolved to its binding, its config and its credential, and a second door would be a second copy of that resolution.
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

async function onPullRequest(ctx: DeliveryContext, payload: PullRequestPayload): Promise<number> {
  const written = await applyPullRequestEvent(ctx, payload);
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
    case 'workflow_run':
      return applyWorkflowRunEvent(ctx, payload as WorkflowRunPayload);
  }
}
