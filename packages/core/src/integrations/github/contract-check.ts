import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { logger } from '../../logger.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { githubBindingCredential } from './binding-credential.js';
import { type CheckRefusal, describeThrown } from './check-refusal.js';
import { publishContractCheck } from './check-run.js';
import { buildRepoClient, GitHubClientError } from './client.js';

/** The delivery event every publish, skip and refusal is logged under. */
export const CHECK_PUBLISH_EVENT = 'check_run.publish';

export type ContractCheckOutcome =
  | { kind: 'published'; deliveryId: string; outcome: 'created' | 'updated'; checkRunId: number }
  | { kind: 'skipped'; deliveryId: string; reason: string }
  | { kind: 'refused'; deliveryId: string; refusal: CheckRefusal };

interface StoredRow {
  id: string;
  bindingId: string;
  issueId: string | null;
  headSha: string;
  headRef: string;
  number: number;
}

async function storedRow(pullRequestId: string): Promise<StoredRow | null> {
  const [row] = await db
    .select({
      id: repoPullRequests.id,
      bindingId: repoPullRequests.bindingId,
      issueId: repoPullRequests.issueId,
      headSha: repoPullRequests.headSha,
      headRef: repoPullRequests.headRef,
      number: repoPullRequests.number,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, pullRequestId))
    .limit(1);
  return row ?? null;
}

async function openDelivery(row: StoredRow): Promise<string> {
  return recordDelivery({
    bindingId: row.bindingId,
    direction: 'outbound',
    eventName: CHECK_PUBLISH_EVENT,
    payload: {
      pullRequestId: row.id,
      number: row.number,
      headSha: row.headSha,
      headRef: row.headRef,
      issueId: row.issueId,
    },
    status: 'pending',
  });
}

async function skip(deliveryId: string, reason: string): Promise<ContractCheckOutcome> {
  await updateDelivery(deliveryId, {
    status: 'ok',
    response: { skipped: true, reason },
    completedAt: new Date(),
  });
  return { kind: 'skipped', deliveryId, reason };
}

/**
 * Publish `forge/issue-contract` for one stored pull request.
 *
 * Never throws for the event-driven callers: every way out is an outcome with a
 * delivery row behind it. Those callers are a hooks subscriber or a webhook
 * delivery handler, and throwing at either would cost the thing that called it —
 * a hook subscriber's failure, or a 200 turned into a 500 that has GitHub
 * redeliver a payload in order to retry a write.
 *
 * The ONE throw is `expectBindingId` disagreeing with the row, and it is reached
 * only from `dispatchOutbound`, whose own contract is to refuse a bad call by
 * name. It is deliberately not a delivery row: nothing was attempted against any
 * repository, and a row scoped to either binding would name a repository this
 * call has no business associating with the other.
 */
export async function publishForStoredPullRequest(
  pullRequestId: string,
  expectBindingId?: string,
): Promise<ContractCheckOutcome | null> {
  const row = await storedRow(pullRequestId);
  if (!row) return null;
  if (expectBindingId !== undefined && row.bindingId !== expectBindingId) {
    throw new GitHubClientError(
      'no_binding',
      `pull request ${pullRequestId} is stored under GitHub binding ${row.bindingId}, and this dispatch was authorised for ${expectBindingId} — Forge will not publish a check run on a repository the caller did not name`,
    );
  }

  const deliveryId = await openDelivery(row);

  if (!row.issueId) {
    return skip(
      deliveryId,
      `the head branch \`${row.headRef}\` names no issue on this project, so there is no contract to report`,
    );
  }

  const credential = await githubBindingCredential(row.bindingId);
  if ('refusal' in credential) return skip(deliveryId, credential.refusal);

  if (credential.config.contractCheck === false) {
    return skip(
      deliveryId,
      'this binding sets `contractCheck: false`, so Forge publishes no contract check on it',
    );
  }

  try {
    const client = buildRepoClient({
      bindingId: row.bindingId,
      config: credential.config,
      secrets: credential.secrets,
    });
    const published = await publishContractCheck(client, {
      issueId: row.issueId,
      headSha: row.headSha,
    });
    await updateDelivery(deliveryId, {
      status: 'ok',
      response: { ...published },
      completedAt: new Date(),
    });
    return {
      kind: 'published',
      deliveryId,
      outcome: published.outcome,
      checkRunId: published.checkRunId,
    };
  } catch (err) {
    if (err instanceof GitHubClientError) return skip(deliveryId, err.message);
    const refusal = describeThrown(err, 'create');
    logger.warn(
      { pullRequestId, bindingId: row.bindingId, cause: refusal.cause, op: refusal.op },
      'contract check: GitHub refused the publish',
    );
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: refusal.message,
      response: { cause: refusal.cause, op: refusal.op, status: refusal.status },
      completedAt: new Date(),
    });
    return { kind: 'refused', deliveryId, refusal };
  }
}

/**
 * Record that a pull request was deliberately not published for, without asking
 * GitHub anything.
 *
 * What the fan-out cap uses. The cap bounds the REQUESTS, and a pull request
 * past it is in exactly the state of one nobody could publish for — so it gets
 * the same row saying so, rather than being dropped on the floor. This is the
 * shape `projection-events.ts` already keeps for a base push: reading the cap as
 * permission to stop writing is what leaves rows stale with nothing on them.
 */
export async function noteNotPublished(
  pullRequestId: string,
  reason: string,
): Promise<ContractCheckOutcome | null> {
  const row = await storedRow(pullRequestId);
  if (!row) return null;
  return skip(await openDelivery(row), reason);
}

/** Every open pull request this issue has, oldest first. */
export async function openPullRequestsForIssue(issueId: string): Promise<string[]> {
  const rows = await db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.issueId, issueId), eq(repoPullRequests.state, 'open')))
    .orderBy(repoPullRequests.number);
  return rows.map((r) => r.id);
}

export async function openPullRequestsForProject(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.projectId, projectId), eq(repoPullRequests.state, 'open')))
    .orderBy(repoPullRequests.number);
  return rows.map((r) => r.id);
}
