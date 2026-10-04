import { logger } from '../../observability/logger.js';
import type { InboundFact } from '../index.js';
import {
  applyCheckRunEvent,
  applyPullRequestEvent,
  applyReviewEvent,
  BASE_PUSH_REFRESH_CAP,
  branchOfPush,
  type CheckRunPayload,
  findRowByNumber,
  markRefreshCapped,
  openPullRequestsOnBase,
  type ProjectionContext,
  type PullRequestPayload,
  type PushPayload,
  type ReviewPayload,
  stateOf,
  storeRefreshRefusal,
} from '../source-host/index.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
import { refreshStoredPullRequest } from './projection-refresh.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/** The events this projection is built from. Anything else falls through. */
const PROJECTED_EVENTS = ['pull_request', 'check_run', 'pull_request_review', 'push'] as const;

type ProjectedEvent = (typeof PROJECTED_EVENTS)[number];

function isProjectedEvent(eventType: string): eventType is ProjectedEvent {
  return (PROJECTED_EVENTS as readonly string[]).includes(eventType);
}

/** What a delivery brings with it: its own binding, config and credential, and the facts it reports. */
interface DeliveryContext extends ProjectionContext {
  config: GitHubConfig;
  secrets: GitHubSecrets;
  /** Collected here and emitted by the inbound door for the modules that own each effect. */
  facts: InboundFact[];
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

/** A merge a person made on GitHub, reported for the issue's merge stamp. */
function reportMerged(ctx: DeliveryContext, payload: PullRequestPayload): void {
  const pr = payload.pull_request;
  if (!pr || stateOf(pr) !== 'merged') return;
  if (!pr.merge_commit_sha || !pr.merged_at || !pr.head?.ref) return;
  ctx.facts.push({
    type: 'source.merged',
    payload: {
      projectId: ctx.projectId,
      headRef: pr.head.ref,
      commitSha: pr.merge_commit_sha,
      mergedAt: pr.merged_at,
    },
  });
}

async function onPullRequest(ctx: DeliveryContext, payload: PullRequestPayload): Promise<number> {
  const written = await applyPullRequestEvent(ctx, payload);
  reportMerged(ctx, payload);
  if (written === 0) return 0;
  if (!REFRESHING_PR_ACTIONS.has(payload.action ?? '')) return written;
  const number = payload.pull_request?.number;
  if (typeof number !== 'number') return written;
  const row = await findRowByNumber(ctx, number);
  if (!row) return written;
  const got = clientFor(ctx);
  if (got.client) await refreshStoredPullRequest(got.client, row.id);
  else await storeRefreshRefusal([row], got.reason);
  return written;
}

async function onPush(ctx: DeliveryContext, payload: PushPayload): Promise<number> {
  const branch = branchOfPush(payload);
  ctx.facts.push({
    type: 'source.pushed',
    payload: {
      projectId: ctx.projectId,
      bindingId: ctx.bindingId,
      branch,
      commit: payload.after ?? null,
      defaultBranch: payload.repository?.default_branch ?? null,
    },
  });
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
 * Store the review, and report it for the issue its head branch names.
 *
 * The two halves answer different questions and neither replaces the other: the projection holds
 * every review still standing on a pull request, which is state a master reads; the comment the
 * comments domain writes from the report is the REVIEW THREAD, and ISS-1074's rule is that there is
 * one of those whichever side wrote into it.
 */
async function onReview(ctx: DeliveryContext, payload: ReviewPayload): Promise<number> {
  const written = await applyReviewEvent(ctx, payload);
  const review = payload.review;
  const headRef = payload.pull_request?.head?.ref;
  const number = payload.pull_request?.number;
  if (payload.action === 'dismissed' || !review?.id || !headRef || typeof number !== 'number') {
    return written;
  }
  ctx.facts.push({
    type: 'source.reviewed',
    payload: {
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
    },
  });
  return written;
}

/** Apply one delivery to the projection, and report how many rows it moved. */
async function applyProjectedEvent(
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

/** What one delivery carries, whichever event it is. */
export type GitHubEventPayload = { action?: string } & Record<string, unknown>;

/** One GitHub delivery, applied to the projection; an event no reader owns writes nothing. */
export async function handleGitHubEvent(
  ctx: DeliveryContext,
  eventType: string,
  payload: GitHubEventPayload,
): Promise<number> {
  if (isProjectedEvent(eventType)) return applyProjectedEvent(ctx, eventType, payload);
  logger.info(
    { key: `${eventType}.${payload.action ?? 'unknown'}`, projectId: ctx.projectId },
    'github: no reader for this event, nothing written; a GitHub issue does not become a Forge issue',
  );
  return 0;
}
