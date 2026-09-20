/**
 * Writing the repository projection from what a delivery carried.
 *
 * Four events, one row shape. Everything here is derived from the payload alone
 * and nothing calls GitHub: what a payload cannot answer is
 * `projection-refresh.ts`'s, and it runs after this has committed so a failed
 * read can never cost the fact the delivery did carry.
 *
 * Nothing here creates, closes or transitions a Forge issue. A pull request is a
 * change under review, not a unit of work, and the guard in
 * `webhooks/github-adapter.ts` that says so is the older half of this rule.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type ProjectedCheckRun,
  type ProjectedReview,
  repoPullRequests,
} from '../../db/schema-repo-projection.js';
import { resolveIssueForHeadRef } from './issue-link.js';
import { foldCheckRun, foldReviewDismissed, foldReviewSubmitted } from './projection-shape.js';

/** What the caller already knows about the delivery's binding. */
export interface ProjectionContext {
  projectId: string;
  bindingId: string;
}

export interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    title?: string;
    html_url?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    updated_at?: string | null;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string; sha?: string };
  };
  repository?: { full_name?: string };
}

export interface CheckRunPayload {
  check_run?: {
    id?: number;
    name?: string;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    details_url?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    app?: { slug?: string } | null;
    pull_requests?: Array<{ number?: number }>;
  };
  repository?: { full_name?: string };
}

export interface ReviewPayload {
  action?: string;
  review?: {
    id?: number;
    state?: string;
    submitted_at?: string | null;
    html_url?: string | null;
    user?: { login?: string } | null;
    /** What the reviewer wrote. Nothing here reads it; `review-note.ts` records it (ISS-1074). */
    body?: string | null;
  };
  pull_request?: { number?: number; head?: { ref?: string } };
}

export interface PushPayload {
  ref?: string;
  after?: string;
}

/** The state a payload reports, with `merged` kept apart from `closed`. */
export function stateOf(pr: NonNullable<PullRequestPayload['pull_request']>) {
  if (pr.merged === true || pr.merged_at) return 'merged' as const;
  return pr.state === 'closed' ? ('closed' as const) : ('open' as const);
}

/**
 * Which of the two routes to this writer a payload came down.
 *
 * `delivery` is a `pull_request` webhook, ordered against what is stored on GitHub's `updated_at`.
 * `creation` is the answer to `POST /pulls` — the FIRST state that pull request ever had, which is
 * why it has an ordering rule of its own rather than the same one.
 */
export type PullRequestWriteMode = 'delivery' | 'creation';

/**
 * Store what a `pull_request` delivery said.
 *
 * One statement, because the head-change rule and the out-of-order rule are two
 * conditions over the same row and splitting them into a read and a write opens
 * a window where a second delivery lands between the two.
 *
 * ISS-1123 — `mode` picks the conflict rule and nothing else; there is still one statement and one
 * writer. A delivery wins on `>=` because a redelivery of the SAME event carries the same timestamp
 * and must still land. A creation answer must not: `updated_at` has second resolution, so any
 * change to the request inside the second it was opened produces a delivery whose timestamp TIES
 * the creation answer's, and a creation write arriving after it would overwrite that delivery's
 * state, head and merge evidence on the strength of the tie. There is no stored row a creation
 * answer is newer than — it describes the request at the instant it began — so it never overwrites
 * one, and the caller reads the zero rows back as `superseded`.
 */
export async function applyPullRequestEvent(
  ctx: ProjectionContext,
  payload: PullRequestPayload,
  mode: PullRequestWriteMode = 'delivery',
): Promise<number> {
  const pr = payload.pull_request;
  const number = pr?.number;
  const headRef = pr?.head?.ref;
  const headSha = pr?.head?.sha;
  const baseRef = pr?.base?.ref;
  const baseSha = pr?.base?.sha;
  if (!pr || !number || !headRef || !headSha || !baseRef || !baseSha) return 0;

  const issueId = await resolveIssueForHeadRef({ projectId: ctx.projectId, headRef });
  const updatedAt = pr.updated_at ? new Date(pr.updated_at) : null;

  const sameTarget = sql`${repoPullRequests.headSha} = excluded.head_sha AND ${repoPullRequests.baseRef} = excluded.base_ref`;

  const rows = await db
    .insert(repoPullRequests)
    .values({
      projectId: ctx.projectId,
      bindingId: ctx.bindingId,
      issueId,
      number,
      repoFullName: payload.repository?.full_name ?? '',
      title: pr.title ?? '',
      htmlUrl: pr.html_url ?? null,
      state: stateOf(pr),
      draft: pr.draft === true,
      headRef,
      headSha,
      baseRef,
      baseSha,
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      mergeCommitSha: pr.merge_commit_sha ?? null,
      payloadUpdatedAt: updatedAt,
    })
    .onConflictDoUpdate({
      target: [repoPullRequests.bindingId, repoPullRequests.number],
      set: {
        issueId: sql`excluded.issue_id`,
        title: sql`excluded.title`,
        htmlUrl: sql`excluded.html_url`,
        state: sql`excluded.state`,
        draft: sql`excluded.draft`,
        headRef: sql`excluded.head_ref`,
        headSha: sql`excluded.head_sha`,
        baseRef: sql`excluded.base_ref`,
        baseSha: sql`excluded.base_sha`,
        mergedAt: sql`excluded.merged_at`,
        mergeCommitSha: sql`excluded.merge_commit_sha`,
        payloadUpdatedAt: sql`excluded.payload_updated_at`,
        behindBy: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.behindBy} END`,
        aheadBy: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.aheadBy} END`,
        mergeable: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.mergeable} END`,
        mergeableState: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.mergeableState} END`,
        refreshedForHead: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.refreshedForHead} END`,
        refreshError: sql`CASE WHEN ${sameTarget} THEN ${repoPullRequests.refreshError} END`,
        updatedAt: new Date(),
      },
      setWhere:
        mode === 'creation'
          ? sql`false`
          : sql`${repoPullRequests.payloadUpdatedAt} IS NULL OR excluded.payload_updated_at IS NULL OR excluded.payload_updated_at >= ${repoPullRequests.payloadUpdatedAt}`,
    })
    .returning({ id: repoPullRequests.id });
  return rows.length;
}

/** The stored row a `check_run` delivery is about, by the PRs it names or by its head. */
async function rowsForCheckRun(
  ctx: ProjectionContext,
  run: NonNullable<CheckRunPayload['check_run']>,
): Promise<Array<{ id: string }>> {
  const numbers = (run.pull_requests ?? [])
    .map((p) => p.number)
    .filter((n): n is number => typeof n === 'number');
  if (numbers.length > 0) {
    return db
      .select({ id: repoPullRequests.id })
      .from(repoPullRequests)
      .where(
        and(
          eq(repoPullRequests.bindingId, ctx.bindingId),
          inArray(repoPullRequests.number, numbers),
        ),
      );
  }
  if (!run.head_sha) return [];
  return db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.bindingId, ctx.bindingId),
        eq(repoPullRequests.headSha, run.head_sha),
      ),
    );
}

/** Store what a `check_run` delivery said, under its own ordering rule. */
export async function applyCheckRunEvent(
  ctx: ProjectionContext,
  payload: CheckRunPayload,
): Promise<number> {
  const run = payload.check_run;
  if (!run?.id || !run.head_sha || !run.status) return 0;
  const incoming: ProjectedCheckRun = {
    id: String(run.id),
    name: run.name ?? '(unnamed check)',
    app: run.app?.slug ?? 'unknown',
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion ?? null,
    detailsUrl: run.details_url ?? null,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
  };

  const targets = await rowsForCheckRun(ctx, run);
  let written = 0;
  for (const target of targets) {
    written += await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ checks: repoPullRequests.checks, headSha: repoPullRequests.headSha })
        .from(repoPullRequests)
        .where(eq(repoPullRequests.id, target.id))
        .for('update')
        .limit(1);
      if (!row) return 0;
      const next = foldCheckRun(row.checks ?? {}, incoming, row.headSha);
      await tx
        .update(repoPullRequests)
        .set({ checks: next, updatedAt: new Date() })
        .where(eq(repoPullRequests.id, target.id));
      return 1;
    });
  }
  return written;
}

export async function applyReviewEvent(
  ctx: ProjectionContext,
  payload: ReviewPayload,
): Promise<number> {
  const review = payload.review;
  const number = payload.pull_request?.number;
  if (!review?.id || !number) return 0;
  const incoming: ProjectedReview = {
    id: String(review.id),
    reviewer: review.user?.login ?? '(unknown)',
    state: (review.state ?? 'commented').toLowerCase(),
    submittedAt: review.submitted_at ?? null,
    dismissed: payload.action === 'dismissed',
    url: review.html_url ?? null,
  };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: repoPullRequests.id, reviews: repoPullRequests.reviews })
      .from(repoPullRequests)
      .where(
        and(eq(repoPullRequests.bindingId, ctx.bindingId), eq(repoPullRequests.number, number)),
      )
      .for('update')
      .limit(1);
    if (!row) return 0;
    const next =
      payload.action === 'dismissed'
        ? foldReviewDismissed(row.reviews ?? {}, incoming)
        : foldReviewSubmitted(row.reviews ?? {}, incoming);
    await tx
      .update(repoPullRequests)
      .set({ reviews: next, updatedAt: new Date() })
      .where(eq(repoPullRequests.id, row.id));
    return 1;
  });
}

/** The stored row for one pull-request number on this binding, or null. */
export async function findRowByNumber(
  ctx: ProjectionContext,
  number: number,
): Promise<{ id: string; headSha: string; baseRef: string } | null> {
  const [row] = await db
    .select({
      id: repoPullRequests.id,
      headSha: repoPullRequests.headSha,
      baseRef: repoPullRequests.baseRef,
    })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.bindingId, ctx.bindingId), eq(repoPullRequests.number, number)))
    .limit(1);
  return row ?? null;
}

/** The branch a `push` delivery moved, or null for a tag or anything else. */
export function branchOfPush(payload: PushPayload): string | null {
  const ref = payload.ref ?? '';
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/**
 * The open pull requests based on the branch this push moved, oldest first.
 *
 * Every one of them, not a page: the caller refreshes a bounded prefix and must
 * write the truncation onto ALL the rest, so a query that stopped at the cap
 * would leave the remainder stale with nothing on them saying so.
 */
export async function openPullRequestsOnBase(
  ctx: ProjectionContext,
  baseRef: string,
): Promise<Array<{ id: string; headSha: string; baseRef: string }>> {
  return db
    .select({
      id: repoPullRequests.id,
      headSha: repoPullRequests.headSha,
      baseRef: repoPullRequests.baseRef,
    })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.bindingId, ctx.bindingId),
        eq(repoPullRequests.baseRef, baseRef),
        eq(repoPullRequests.state, 'open'),
      ),
    )
    .orderBy(repoPullRequests.number);
}
