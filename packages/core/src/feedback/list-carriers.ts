/**
 * An issue route's carriers as the feedback list reads them: each carrier's row, and which of them a
 * planned item still waits on. A carrier its holder closed met in scope waits for the release that
 * carries it (`issues/waiting-for-release.ts:closedUnreleasedSql`): `closed` says its criteria were
 * met in scope, never that its work is live (ISS-1062).
 */

import type { FeedbackCarrierView, FeedbackRouteView } from '@forge/contracts/feedback';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedPerId, rowsPerId } from '../db/read-memo.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { issueCriteria } from '../db/schema-issue-criteria.js';
import { closedUnreleasedSql } from '../issues/index.js';
import type { Row } from './read.js';

/** Each issue a page of feedback names, with the release claiming it and whether it waits for one. */
export function carrierIssueRows(issueIds: readonly string[]) {
  // an issue's row is its own: every project's asks are one read (ISS-1070 r6)
  return rowsPerId('carrierIssueRows', issueIds, carrierRowsOf, (r) => r.id);
}

const carrierRowsOf = (issueIds: readonly string[]) =>
  db
    .select({
      id: issues.id,
      seq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      releaseVersion: pipelineRuns.releaseVersion,
      unreleased: sql<boolean>`${closedUnreleasedSql(sql`${issues}`)}`,
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

/** A carrier's live criteria by their latest verdict: `fail` (ISS-1159) and `skipped`, owed live (ISS-1234). */
export interface CarrierHeld {
  failing: number[];
  owed: number[];
}

/**
 * The numbers of each issue's live criteria whose latest verdict is `fail` (ISS-1159): a carrier that
 * shipped with one does not resolve the item it carries; and `skipped` (ISS-1234: agenfold FB-283 was
 * verified by ship while its carrier's c3 was owed a live verdict): one held so is not verified by
 * ship. Asked only for the carriers that would otherwise resolve an item (`list-read.ts:linkedOf`),
 * and every project's asks are one statement (`db/read-memo.ts:memoizedPerId`), so the shell's reads
 * stay within their buffer ceilings.
 */
export function heldCriteriaOf(issueIds: readonly string[]) {
  return memoizedPerId('feedbackCarrierHeld', issueIds, async (some) => {
    // the column named with its table: drizzle prints a select field's column bare, which inside the
    // subquery would read criterion_verdicts' own id
    const latest = sql<string>`(SELECT v.verdict FROM criterion_verdicts v WHERE v.criterion_id = "issue_criteria"."id"
                ORDER BY v.created_at DESC LIMIT 1)`;
    const rows = await db
      .select({ issueId: issueCriteria.issueId, n: issueCriteria.n, verdict: latest })
      .from(issueCriteria)
      .where(
        and(
          inArray(issueCriteria.issueId, [...some]),
          isNull(issueCriteria.retiredAt),
          sql`${latest} IN ('fail', 'skipped')`,
        ),
      )
      .orderBy(issueCriteria.n);
    const held = new Map<string, CarrierHeld>(some.map((id) => [id, { failing: [], owed: [] }]));
    for (const r of rows) {
      const h = held.get(r.issueId);
      if (h) (r.verdict === 'fail' ? h.failing : h.owed).push(r.n);
    }
    return held;
  });
}

/**
 * The carriers whose failing criteria an item's phase reads (ISS-1159): those of a triaged issue-routed
 * item every carrier of which is closed and released, which would otherwise read resolved.
 */
export function shippedCarriersOfTriaged(
  rows: readonly Pick<Row, 'id' | 'status' | 'route'>[],
  routeIssues: ReadonlyMap<string, string[]>,
  issueRows: readonly { id: string; status: string; unreleased: boolean }[],
): string[] {
  const byId = new Map(issueRows.map((i) => [i.id, i]));
  const shipped = rows.flatMap((r) => {
    if (r.status !== 'triaged' || r.route !== 'issue') return [];
    const carrying = (routeIssues.get(r.id) ?? []).flatMap((id) => {
      const issue = byId.get(id);
      return issue && issue.status !== 'dropped' ? [issue] : [];
    });
    return carrying.every((i) => i.status === 'closed' && !i.unreleased)
      ? carrying.map((i) => i.id)
      : [];
  });
  return [...new Set(shipped)];
}
