/**
 * An unchanged re-triage (ISS-833, from FB-411): an item triaged onto a draft carrier still reads
 * `triaged` and may be re-routed, but a triage naming the route and carriers it already stands on
 * moves nothing, and its decision would move the standing `since` past the master's answer so the
 * steward asks the master again. One rule judges it for a direct triage, a proposed suggestion and
 * an accept alike.
 */

import { type FeedbackTriage, feedbackKey } from '@forge/contracts/feedback';
import { triageRouteOf } from '@forge/contracts/feedback-triage';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { activeIssuePrefix, isUuid } from '../issues/index.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type Row, rowIn } from './read.js';
import { isRefusal, requirementRefIn } from './refs.js';
import { type FeedbackRefusal, refusal } from './rules.js';

/** The issues of `projectId` a triage names, as ids; null where one names no issue of the project. */
async function issueIdsNamed(
  tx: Tx,
  projectId: string,
  named: string | string[],
): Promise<Set<string> | null> {
  const ids = new Set<string>();
  for (const ref of typeof named === 'string' ? [named] : named) {
    const seq = /^\s*(?:[A-Za-z][A-Za-z0-9]{1,5}-)?(\d{1,10})\s*$/.exec(ref)?.[1];
    const found = (await tx.execute(
      isUuid(ref)
        ? sql`SELECT id FROM issues WHERE project_id = ${projectId} AND id = ${ref}`
        : seq
          ? sql`SELECT id FROM issues WHERE project_id = ${projectId} AND iss_seq = ${Number(seq)}`
          : sql`SELECT id FROM issues WHERE false`,
    )) as unknown as { id: string }[];
    if (!found[0]) return null;
    ids.add(found[0].id);
  }
  return ids;
}

/** What the item stands on for `route`: the carriers' keys, or null where the triage names others. */
async function sameCarriers(
  tx: Tx,
  row: Row,
  t: FeedbackTriage,
  route: string,
): Promise<string[] | null> {
  if (route === 'issue') {
    const standing = (await tx.execute(sql`
      SELECT i.id, i.iss_seq FROM feedback_route_issues r JOIN issues i ON i.id = r.issue_id
       WHERE r.feedback_id = ${row.id} ORDER BY i.iss_seq
    `)) as unknown as { id: string; iss_seq: number }[];
    // an issue route naming no issue, or a filing, files a new carrier: never unchanged
    if (!t.issue || t.createIssue || standing.length === 0) return null;
    const named = await issueIdsNamed(tx, row.projectId, t.issue);
    if (!named || named.size !== standing.length || standing.some((s) => !named.has(s.id))) {
      return null;
    }
    const prefix = await activeIssuePrefix(row.projectId);
    return standing.map((s) => formatIssueRef(prefix, s.iss_seq));
  }
  if (route === 'revision') {
    return t.suggestion && t.suggestion === row.routedSuggestionId ? [t.suggestion] : null;
  }
  if (route === 'new_requirement') {
    if (!t.requirement || t.title) return null;
    const req = await requirementRefIn(row.projectId, t.requirement, '/requirement');
    return !isRefusal(req) && req.id === row.routedRequirementId ? [req.key] : null;
  }
  if (route === 'duplicate') {
    if (!t.duplicateOf || !row.duplicateOf) return null;
    const root = await rowIn(tx, row.projectId, t.duplicateOf).catch(() => null);
    return root && root.id === row.duplicateOf ? [feedbackKey(root.fbSeq)] : null;
  }
  if (route === 'answer') {
    const text = storedText(await dataPolicyOf(row.projectId), (t.answer ?? '').trim()).text;
    return text && text === row.answer ? ['the answer already given'] : null;
  }
  return null;
}

/**
 * A triage of `row` that names the route and carriers it already stands on is refused by name and
 * writes nothing. Only an item stored `triaged` has a standing: a new or reopened item is never
 * unchanged, and a decline is a different act.
 */
export async function unchangedTriageRefusal(
  tx: Tx,
  row: Row,
  triage: FeedbackTriage,
): Promise<FeedbackRefusal | null> {
  if (row.status !== 'triaged' || !row.route) return null;
  const route =
    triage.route === 'decline'
      ? 'decline'
      : triageRouteOf({
          kind: triage.kind ?? row.kind,
          route: triage.route,
          answers: triage.answers,
        });
  if (route !== row.route) return null;
  const carriers = await sameCarriers(tx, row, triage, route);
  if (!carriers) return null;
  return refusal(
    'FEEDBACK_TRIAGE_UNCHANGED',
    '/route',
    `${feedbackKey(row.fbSeq)} already stands on route ${route}, carried by ${carriers.join(', ')}; this triage names the same route and carriers, so nothing was written. Name another carrier or route to move it.`,
  );
}
