/**
 * ISS-1123 — what Forge opens, Forge records.
 *
 * `repo_pull_requests` had exactly one writer and exactly one route to it: a `pull_request`
 * delivery arriving at `POST /api/webhooks/in/:slug`. A pull request the agent face opened left no
 * row at all, so the merge route resolved nothing and refused every pull request on the project —
 * including the one Forge was certain about, because it had just created it.
 *
 * This is the second route to the SAME writer, in the shape `review-note.ts` already holds for the
 * review path: the webhook arm and the agent face reach ONE function, so "no second record" stays a
 * property of there being one writer rather than of two call sites agreeing. Nothing here inserts,
 * and nothing here calls GitHub — the answer the creation call already returned is all it reads.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import type { OpenedPullRequest } from './agent-ops.js';
import { applyPullRequestEvent, type PullRequestPayload } from './projection.js';

export type OpenedProjectionOutcome =
  /** This call wrote the row. */
  | 'recorded'
  /** A newer record of this number already stood, so the writer kept it. Not a failure. */
  | 'superseded'
  /** Nothing was written, and `reason` says what stopped it. The pull request still exists. */
  | 'not-recorded';

export interface OpenedProjectionResult {
  outcome: OpenedProjectionOutcome;
  /** The Forge issue the row is linked to, where the head branch names one. */
  issueId: string | null;
  /** Why there is no row. Null where there is one. */
  reason: string | null;
}

/**
 * A creation answer that cannot become a row, named field by field.
 *
 * The row's identity columns are `NOT NULL` and the merge route resolves on them, so a partial row
 * is not a lesser record — it is a row the merge would find and then fail to act on. GitHub sending
 * a pull request back without a head sha is not a shape this widens to accept.
 */
export class OpenedPullRequestIncomplete extends Error {
  readonly missing: string[];
  constructor(missing: string[], repository: string) {
    super(
      `github: the answer to opening a pull request on ${repository} carried no ${missing.join(', no ')}, ` +
        'so Forge cannot write the projection row the merge route resolves on. The pull request EXISTS on ' +
        'GitHub and nothing here is retried; a `pull_request` delivery for it, or opening it again after ' +
        'GitHub answers completely, writes the same row.',
    );
    this.name = 'OpenedPullRequestIncomplete';
    this.missing = missing;
  }
}

/** The five identity fields, present — or the names of the ones GitHub left out. */
interface RowIdentity {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

function identityOf(opened: OpenedPullRequest): RowIdentity | { missing: string[] } {
  const missing: string[] = [];
  if (!opened.number) missing.push('number');
  if (!opened.headRef) missing.push('head ref');
  if (!opened.headSha) missing.push('head sha');
  if (!opened.baseRef) missing.push('base ref');
  if (!opened.baseSha) missing.push('base sha');
  if (missing.length > 0) return { missing };
  return {
    number: opened.number,
    headRef: opened.headRef,
    headSha: opened.headSha as string,
    baseRef: opened.baseRef,
    baseSha: opened.baseSha as string,
  };
}

/**
 * The delivery shape, built from the creation answer.
 *
 * Not a forged webhook: GitHub returns the same `pull_request` object from `POST /pulls` that it
 * puts in a `pull_request` delivery, so this hands the writer the object it already models rather
 * than teaching it a second one. `updated_at` travels unchanged, because it is what the writer's
 * ordering rule turns on.
 */
function payloadFor(args: {
  repository: string;
  opened: OpenedPullRequest;
  identity: RowIdentity;
}): PullRequestPayload {
  const { opened, identity } = args;
  return {
    action: 'opened',
    pull_request: {
      number: identity.number,
      title: opened.title,
      ...(opened.url === null ? {} : { html_url: opened.url }),
      state: opened.state,
      draft: opened.draft,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      updated_at: opened.updatedAt,
      head: { ref: identity.headRef, sha: identity.headSha },
      base: { ref: identity.baseRef, sha: identity.baseSha },
    },
    repository: { full_name: args.repository },
  };
}

/** The stored row for this number, read back rather than resolved a second time. */
async function storedRow(
  bindingId: string,
  number: number,
): Promise<{ issueId: string | null } | undefined> {
  const [row] = await db
    .select({ issueId: repoPullRequests.issueId })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.bindingId, bindingId), eq(repoPullRequests.number, number)))
    .limit(1);
  return row;
}

/**
 * Record a pull request the agent face just opened, through the projection's own writer.
 *
 * Opening is not landing: the payload says `merged: false` with no merge commit and no merge time,
 * so `stateOf` reads `open` and the row carries no merge evidence. The stamp stays the merge's,
 * which is the single-writer rule this must not route around.
 */
export async function projectOpenedPullRequest(args: {
  projectId: string;
  bindingId: string;
  /** `owner/repo`, as the binding spells it. */
  repository: string;
  opened: OpenedPullRequest;
}): Promise<OpenedProjectionResult> {
  const identity = identityOf(args.opened);
  if ('missing' in identity) {
    throw new OpenedPullRequestIncomplete(identity.missing, args.repository);
  }

  const written = await applyPullRequestEvent(
    { projectId: args.projectId, bindingId: args.bindingId },
    payloadFor({ repository: args.repository, opened: args.opened, identity }),
  );
  const row = await storedRow(args.bindingId, identity.number);
  const issueId = row?.issueId ?? null;

  if (written > 0) return { outcome: 'recorded', issueId, reason: null };
  if (row) {
    return {
      outcome: 'superseded',
      issueId,
      reason:
        `Forge already holds a record of #${args.opened.number} on ${args.repository} that is newer than ` +
        'this creation answer, so the newer one stands. Nothing was overwritten.',
    };
  }
  return {
    outcome: 'not-recorded',
    issueId: null,
    reason:
      `the projection writer wrote no row for #${args.opened.number} on ${args.repository} and no row for ` +
      'that number is there, which is a state this path does not otherwise produce. The pull request EXISTS ' +
      'on GitHub; merging it through Forge needs a row, and none is here.',
  };
}
