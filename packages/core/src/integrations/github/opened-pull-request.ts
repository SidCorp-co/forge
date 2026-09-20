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
  /**
   * Why there is no row — or, under `recorded`, what could not be read back after there was one.
   * Null where the row was written and read.
   */
  reason: string | null;
}

/**
 * A creation answer that cannot become a row, named field by field.
 *
 * The row's identity columns are `NOT NULL` and the merge route resolves on them, so a partial row
 * is not a lesser record — it is a row the merge would find and then fail to act on. GitHub sending
 * a pull request back without a head sha is not a shape this widens to accept, and nor is one
 * without the `updated_at` the writer orders on — `RowIdentity` says what that absence costs.
 */
export class OpenedPullRequestIncomplete extends Error {
  readonly missing: string[];
  constructor(missing: string[], repository: string) {
    super(
      `github: the answer to opening a pull request on ${repository} carried no ${missing.join(', no ')}, ` +
        'so Forge cannot write the projection row the merge route resolves on. The pull request EXISTS on ' +
        'GitHub and nothing here is retried. Do NOT open it again — that would put a second pull request ' +
        'on the repository. A `pull_request` delivery for the one that exists writes the same row.',
    );
    this.name = 'OpenedPullRequestIncomplete';
    this.missing = missing;
  }
}

/**
 * The six fields a row cannot be written without — or the names of the ones GitHub left out.
 *
 * `updated_at` is one of them, and it is here for a reason the other five are not: it is the only
 * field whose ABSENCE is louder than its presence. The writer's `setWhere` reads a null
 * `payload_updated_at` on the incoming row as always-wins, so a creation answer that carried no
 * timestamp would not merely arrive unordered — it would overwrite a `merged` row's state, head and
 * merge commit with `open` and no merge evidence, silently, and the merge stamp this whole path
 * exists to protect would be gone. Refusing it by name is the loud break; widening the writer to
 * cope is the silent substitution.
 */
interface RowIdentity {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  updatedAt: string;
}

function identityOf(opened: OpenedPullRequest): RowIdentity | { missing: string[] } {
  const missing: string[] = [];
  if (!opened.number) missing.push('number');
  if (!opened.headRef) missing.push('head ref');
  if (!opened.headSha) missing.push('head sha');
  if (!opened.baseRef) missing.push('base ref');
  if (!opened.baseSha) missing.push('base sha');
  if (!opened.updatedAt) missing.push('updated at');
  if (missing.length > 0) return { missing };
  return {
    number: opened.number,
    headRef: opened.headRef,
    headSha: opened.headSha as string,
    baseRef: opened.baseRef,
    baseSha: opened.baseSha as string,
    updatedAt: opened.updatedAt as string,
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
      updated_at: identity.updatedAt,
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

  // The write has COMMITTED by here. Reading the row back is how this call reports which issue the
  // branch resolved to, and a read that fails says nothing about the write that preceded it — so it
  // is caught rather than thrown. Letting it escape turned a committed row into `not-recorded` and a
  // log line saying the projection row never landed, which is the one thing known to be false.
  let row: { issueId: string | null } | undefined;
  let unread: string | null = null;
  try {
    row = await storedRow(args.bindingId, identity.number);
  } catch (err) {
    unread =
      `the row for #${identity.number} on ${args.repository} could not be read back (${String(err)}), ` +
      'so the issue it links to is not reported here.';
  }
  const issueId = row?.issueId ?? null;

  if (written > 0) {
    return {
      outcome: 'recorded',
      issueId,
      reason: unread === null ? null : `${unread} The row itself was written.`,
    };
  }
  if (unread !== null) {
    return {
      outcome: 'not-recorded',
      issueId: null,
      reason:
        `the projection writer wrote no row for #${identity.number} on ${args.repository} this call, and ` +
        `whether one already stands could not be read: ${unread} The pull request EXISTS on GitHub.`,
    };
  }
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
