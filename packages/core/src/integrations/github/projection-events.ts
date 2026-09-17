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
