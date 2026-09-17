/**
 * Which of the four events writes what, and what each one then re-reads.
 *
 * The routing lives here rather than in `webhooks/github-adapter.ts` because
 * that file is the GitHub Issues mirror and has no other reason to know a pull
 * request exists; and rather than in `projection.ts`, which is deliberately
 * payload-only and holds no credential.
 */

import { logger } from '../../logger.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
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
} from './projection-refresh.js';
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

// cm:guard the refresh is BEST EFFORT and its absence is on the row, never in an exception — this runs after the payload write has committed, so throwing would answer the delivery 500 and have GitHub re-deliver a payload in order to retry a read.
function clientOrNull(ctx: DeliveryContext): GitHubRepoClient | null {
  try {
    return buildRepoClient({ bindingId: ctx.bindingId, config: ctx.config, secrets: ctx.secrets });
  } catch (err) {
    if (err instanceof GitHubClientError) {
      logger.info(
        { bindingId: ctx.bindingId, reason: err.reason },
        'repo projection: no App client for this binding, so nothing is re-read',
      );
      return null;
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
  const client = clientOrNull(ctx);
  if (!client) return written;
  const number = payload.pull_request?.number;
  if (typeof number !== 'number') return written;
  const row = await findRowByNumber(ctx, number);
  if (row) await refreshStoredPullRequest(client, row.id);
  return written;
}

async function onPush(ctx: DeliveryContext, payload: PushPayload): Promise<number> {
  const branch = branchOfPush(payload);
  if (!branch) return 0;
  const rows = await openPullRequestsOnBase(ctx, branch, BASE_PUSH_REFRESH_CAP + 1);
  if (rows.length === 0) return 0;
  const within = rows.slice(0, BASE_PUSH_REFRESH_CAP);
  const past = rows.slice(BASE_PUSH_REFRESH_CAP);
  const client = clientOrNull(ctx);
  let touched = 0;
  if (client) {
    for (const row of within) {
      if (await refreshStoredPullRequest(client, row.id)) touched += 1;
    }
  }
  touched += await markRefreshCapped(past.map((r) => r.id));
  return touched;
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
      return applyReviewEvent(ctx, payload as ReviewPayload);
    case 'push':
      return onPush(ctx, payload as PushPayload);
  }
}
