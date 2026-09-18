/**
 * One check-run publish for one stored pull request, and the named refusal for
 * every way it does not happen. ISS-1072.
 *
 * ## Nothing here returns quietly
 *
 * ISS-1072's fifth outcome is that a repository with no binding, a branch that
 * resolves to no issue and a project that turned the check off are each refused
 * or skipped BY NAME in the delivery log, not silently. So every path out of
 * this file writes an `integration_deliveries` row carrying its reason, and the
 * reason is a sentence rather than a code: the person reading that log is
 * deciding what to do next, and `skipped` tells them nothing.
 *
 * A skip is not a failure and is recorded `ok`. "Forge deliberately did not
 * publish, here is why" and "Forge tried and GitHub refused" are different
 * things to an operator, and a delivery log that colours them the same is one
 * they stop reading.
 *
 * ## Which refusals are reachable from here, and which is not
 *
 * `client.ts` has five: `no_binding`, `no_repository`, `no_installation`,
 * `no_connection`, `no_credential`. Four are reachable here. `no_binding` is
 * not, and that is a fact about the schema rather than an oversight:
 * `repo_pull_requests.binding_id` is NOT NULL and cascades from the binding, so
 * a stored pull request always has one and a deleted binding takes its rows with
 * it. The fifth is refused on `dispatchOutbound`'s own door, in `adapter.ts`,
 * where there is a project to name and no binding to scope a row to.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings } from '../../db/schema.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { logger } from '../../logger.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import { type CheckRefusal, describeThrown } from './check-refusal.js';
import { publishContractCheck } from './check-run.js';
import { buildRepoClient, GitHubClientError } from './client.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

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
  // cm:guard a skip is `ok` and carries its reason in `response`, never `failed` with an `errorMessage`. A deliberate non-publish recorded as a failure is what puts a red row in front of an operator for a project that turned the check off on purpose, and an operator who learns the log cries wolf stops opening it.
  await updateDelivery(deliveryId, {
    status: 'ok',
    response: { skipped: true, reason },
    completedAt: new Date(),
  });
  return { kind: 'skipped', deliveryId, reason };
}

/** The binding's config and its connection's secrets, or the refusal in between. */
async function credentialFor(
  bindingId: string,
): Promise<{ config: GitHubConfig; secrets: GitHubSecrets } | { refusal: string }> {
  const [binding] = await db
    .select({ connectionId: integrationBindings.connectionId, config: integrationBindings.config })
    .from(integrationBindings)
    .where(and(eq(integrationBindings.id, bindingId), eq(integrationBindings.active, true)))
    .limit(1);
  if (!binding) {
    return {
      refusal: `the GitHub binding ${bindingId} this pull request was stored under is gone or deactivated`,
    };
  }
  const connection = await findConnectionById(binding.connectionId);
  if (!connection?.active) {
    return {
      refusal: "the GitHub connection behind this project's binding is gone or deactivated",
    };
  }
  return {
    config: (binding.config ?? {}) as GitHubConfig,
    secrets: decryptConnectionSecrets<GitHubSecrets>(connection),
  };
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
// cm:guard `expectBindingId` is how a caller that was authorised for ONE binding says so. A stored
// pull request is addressed by its own uuid and carries its own binding, so a dispatch holding a
// context for binding A and a row belonging to binding B would validate A and then publish to B's
// repository on B's credential — a write nobody authorised, on the wrong repository, reported as a
// success. The event-driven callers name no binding because the row IS what they resolved from.
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

  const credential = await credentialFor(row.bindingId);
  if ('refusal' in credential) return skip(deliveryId, credential.refusal);

  // cm:guard the switch is read off the BINDING and defaults to on. An absent key is a project that has never been asked, and reading absence as off would mean this shipped doing nothing anywhere and nobody finding out for a release.
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
    // cm:guard the four client refusals are SKIPS and not failures: each names something an operator has not set up yet — no repository chosen, no installation, no credential — and none of them is GitHub refusing Forge. Recording them as failures trips the connection breaker on a binding nobody ever finished configuring.
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

/** Every open pull request on this project that names an issue, oldest first. */
export async function openPullRequestsForProject(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.projectId, projectId), eq(repoPullRequests.state, 'open')))
    .orderBy(repoPullRequests.number);
  return rows.map((r) => r.id);
}
