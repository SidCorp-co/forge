/**
 * An issue route's carriers as the feedback list reads them: each carrier's row, and which of them a
 * planned item still waits on. A carrier its holder closed met in scope waits for the release that
 * carries it (`issues/waiting-for-release.ts:closedUnreleasedSql`): `closed` says its criteria were
 * met in scope, never that its work is live (ISS-1062).
 */

import type { FeedbackCarrierView, FeedbackRouteView } from '@forge/contracts/feedback';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { closedUnreleasedSql } from '../issues/index.js';

/** Each issue a page of feedback names, with the release claiming it and whether it waits for one. */
export function carrierIssueRows(issueIds: readonly string[]) {
  // an issue's row is its own: every project's asks are one read (ISS-1070 r6)
  return rowsPerId('carrierIssueRows', issueIds, carrierRowsOf, (r) => r.id);
}

/**
 * The numbers of an issue's live criteria whose latest verdict is `fail`, read inside the carriers'
 * own statement (ISS-1159): a carrier that shipped with one does not resolve the item it carries.
 */
const failingCriteriaSql = sql<number[]>`ARRAY(
  SELECT c.n FROM issue_criteria c
  WHERE c.issue_id = ${issues.id} AND c.retired_at IS NULL
    AND (SELECT v.verdict FROM criterion_verdicts v WHERE v.criterion_id = c.id
         ORDER BY v.created_at DESC, v.id DESC LIMIT 1) = 'fail'
  ORDER BY c.n)`;

const carrierRowsOf = (issueIds: readonly string[]) =>
  db
    .select({
      id: issues.id,
      seq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      releaseVersion: pipelineRuns.releaseVersion,
      unreleased: sql<boolean>`${closedUnreleasedSql(sql`${issues}`)}`,
      failing: failingCriteriaSql,
    })
    .from(issues)
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(inArray(issues.id, [...issueIds]));

/** The keys of an issue route's carriers closed met in scope that no shipped release holds yet. */
export function unreleasedCarrierKeys(
  carrierIds: readonly string[],
  carriers: ReadonlyMap<string, { key: string; unreleased: boolean }>,
): ReadonlySet<string> {
  return new Set(
    carrierIds.flatMap((id) => {
      const issue = carriers.get(id);
      return issue?.unreleased ? [issue.key] : [];
    }),
  );
}

/**
 * What a planned item still waits on: an issue route's carriers not yet closed or dropped, and those
 * closed that still wait for their release (`unreleased`); any other route's one carrier.
 */
export function owedCarriers(
  route: FeedbackRouteView | null,
  unreleased: ReadonlySet<string>,
): FeedbackCarrierView[] {
  if (!route) return [];
  if (route.route !== 'issue') return route.carriers;
  const finished: readonly (string | null)[] = ISSUE_TERMINAL_STATUSES;
  return route.carriers.filter(
    (c) => !finished.includes(c.status) || (c.key !== null && unreleased.has(c.key)),
  );
}
