import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  type ChangeRequestLinkKind,
  type ChangeRequestReading,
  type PullRequestState,
  repoPullRequestIssues,
  repoPullRequests,
} from '../../db/schema-repo-projection.js';
import { forgeReads } from '../index.js';
import { type CheckRollup, rollupOf } from './projection-shape.js';

interface IssuePullRequest {
  number: number;
  repo: string;
  url: string | null;
  title: string;
  state: PullRequestState;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** Commits on the base that this head does not have, or null where no read has answered. */
  behindBy: number | null;
  aheadBy: number | null;
  /** GitHub's own verdict: `clean`, `dirty`, `behind`, `blocked`, `unstable`, `unknown`, or null. */
  mergeableState: string | null;
  /** The head `behindBy`, `aheadBy` and `mergeableState` describe. Null where nothing has. */
  refreshedForHead: string | null;
  /** Why the last read could not answer, or null. An absence with a reason beside it. */
  refreshError: string | null;
  /** Counted over the current head's runs only. */
  checks: CheckRollup;
  reviews: Array<{ id: string; reviewer: string; state: string; submittedAt: string | null }>;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

const ORDER = sql`(${repoPullRequests.state} <> 'open'), ${repoPullRequests.number} DESC`;

export async function readPullRequestsForIssues(
  issueIds: string[],
): Promise<Map<string, IssuePullRequest[]>> {
  const out = new Map<string, IssuePullRequest[]>();
  if (issueIds.length === 0) return out;

  const rows = await db
    .select({ row: repoPullRequests, issueId: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(inArray(repoPullRequestIssues.issueId, issueIds))
    .orderBy(ORDER);

  for (const { row, issueId } of rows) {
    const list = out.get(issueId) ?? [];
    list.push({
      number: row.number,
      repo: row.repoFullName,
      url: row.htmlUrl,
      title: row.title,
      state: row.state,
      draft: row.draft,
      headRef: row.headRef,
      headSha: row.headSha,
      baseRef: row.baseRef,
      behindBy: row.behindBy,
      aheadBy: row.aheadBy,
      mergeableState: row.mergeableState,
      refreshedForHead: row.refreshedForHead,
      refreshError: row.refreshError,
      checks: rollupOf(row.checks ?? {}, row.headSha),
      reviews: Object.values(row.reviews ?? {})
        .filter((r) => !r.dismissed)
        .map((r) => ({
          id: r.id,
          reviewer: r.reviewer,
          state: r.state,
          submittedAt: r.submittedAt ?? null,
        }))
        .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '')),
      mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
      mergeCommitSha: row.mergeCommitSha,
    });
    out.set(issueId, list);
  }
  return out;
}

/** The stored pull request numbered `number` that delivers the issue, or null. */
export async function pullRequestNumbered(issueId: string, number: number): Promise<string | null> {
  const [row] = await db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(and(eq(repoPullRequestIssues.issueId, issueId), eq(repoPullRequests.number, number)))
    .limit(1);
  return row?.id ?? null;
}

/** Every open pull request that delivers this issue, oldest first. */
export async function openPullRequestsForIssue(issueId: string): Promise<string[]> {
  const rows = await db
    .select({ id: repoPullRequests.id })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(and(eq(repoPullRequestIssues.issueId, issueId), eq(repoPullRequests.state, 'open')))
    .orderBy(repoPullRequests.number);
  return rows.map((r) => r.id);
}

/** An issue a stored change request delivers, with the reading that named it (ISS-1027). */
export interface NamedLink {
  issueId: string;
  linkedBy: ChangeRequestLinkKind;
  namedBy: ChangeRequestReading;
}

/**
 * Every issue the stored change request delivers (REQ-63 BC-4), by its row id, primary first, each
 * with the reading that named it: the branch's leading key, its tail's numbers, its title or body.
 */
export async function linksOfPullRequest(
  pullRequestId: string,
  headRef: string,
): Promise<NamedLink[]> {
  const links = await db
    .select({ issueId: repoPullRequestIssues.issueId, linkedBy: repoPullRequestIssues.linkedBy })
    .from(repoPullRequestIssues)
    .where(eq(repoPullRequestIssues.pullRequestId, pullRequestId))
    .orderBy(asc(repoPullRequestIssues.position), asc(repoPullRequestIssues.issueId));
  return forgeReads().changeRequestLinkReadings({ headRef, links });
}

/**
 * The stored row numbered `number` on this binding and every issue it delivers, oldest link first,
 * each with the reading that named it; undefined where Forge holds no row for that number.
 */
export async function linkedIssuesOfNumber(
  bindingId: string,
  number: number,
): Promise<{ id: string; issueIds: string[]; links: NamedLink[] } | undefined> {
  const [row] = await db
    .select({ id: repoPullRequests.id, headRef: repoPullRequests.headRef })
    .from(repoPullRequests)
    .where(and(eq(repoPullRequests.bindingId, bindingId), eq(repoPullRequests.number, number)))
    .limit(1);
  if (!row) return undefined;
  const links = await linksOfPullRequest(row.id, row.headRef);
  return { id: row.id, issueIds: links.map((l) => l.issueId), links };
}
