import { db } from '../../db/client.js';
import { criterionRoutesOf } from '../design-record.js';
import {
  type CriterionRef,
  criterionNamed,
  rewordCriterion,
  rewordingsOf,
  verdictsAcrossPut,
} from './criterion-reword.js';
import { underCutoverOf } from './cutover-marks.js';
import { keptProbesOf } from './probes.js';
import {
  type CriterionInput,
  listCriteria,
  listRetiredCriteria,
  liveRows,
  lockIssue,
  putCriteria,
} from './store.js';
import { withCurrentDrafts } from './storefront-draft.js';
import { appendTracedCriteria } from './tie.js';
import { recordVerdict } from './verdict-record.js';

/**
 * An issue's live criteria with their latest verdicts and the storefront's current drafts, each with
 * the class its design records, the judge that class routes it to (null where none classes it) and
 * the probe it keeps (null where it keeps none). A latest pass the building run recorded before the
 * builder-pass cutover says so (`countedUnderCutover`).
 */
export async function readCriteriaWithDrafts(issue: { id: string; projectId: string }) {
  const criteria = await withCurrentDrafts(issue.projectId, await listCriteria(db, issue.id));
  const ids = criteria.map((c) => c.id);
  const latest = criteria.flatMap((c) => (c.latest ? [c.latest] : []));
  const [routes, probes, underCutover] = await Promise.all([
    criterionRoutesOf(ids),
    keptProbesOf(db, ids),
    underCutoverOf(db, issue.projectId, latest),
  ]);
  return criteria.map((c) => ({
    ...c,
    latest: c.latest ? { ...c.latest, countedUnderCutover: underCutover.has(c.latest.id) } : null,
    class: routes.get(c.id)?.class ?? null,
    judge: routes.get(c.id)?.judge ?? null,
    probe: probes.get(c.id) ?? null,
  }));
}

/**
 * What the criteria read answers: the live criteria with their latest verdicts and the storefront's
 * current drafts, and beside them the retired ones with every verdict each earned.
 */
export async function readCriteriaAndRetired(issue: { id: string; projectId: string }) {
  const [criteria, retired] = await Promise.all([
    readCriteriaWithDrafts(issue),
    listRetiredCriteria(db, issue.id),
  ]);
  return { criteria, retired };
}

/**
 * Replaces an issue's criteria in one transaction, answering which verdicts already recorded it kept
 * and which it voided; null where the issue is gone.
 */
export async function replaceCriteria(issueId: string, criteria: readonly CriterionInput[]) {
  return db.transaction(async (tx) => {
    if (!(await lockIssue(tx, issueId))) return null;
    const before = await liveRows(tx, issueId);
    if (!(await putCriteria(tx, issueId, criteria))) return null;
    const after = new Set((await liveRows(tx, issueId)).map((r) => r.id));
    return verdictsAcrossPut(tx, before, after);
  });
}

/** Corrects one criterion's wording in one transaction, keeping its id and its verdicts. */
export async function correctCriterion(args: Parameters<typeof rewordCriterion>[1]) {
  return db.transaction((tx) => rewordCriterion(tx, args));
}

/** One live criterion as the criteria read shows it, with the history of its wording. */
export async function readCriterion(issue: { id: string; projectId: string }, ref: CriterionRef) {
  const live = await readCriteriaWithDrafts(issue);
  const criterion = criterionNamed(live, ref);
  return { criterion, history: await rewordingsOf(db, issue.id, criterion.id) };
}

/** Records one verdict in its own transaction. */
export async function addVerdict(args: Parameters<typeof recordVerdict>[1]) {
  return db.transaction((tx) => recordVerdict(tx, args));
}

/** Ties the issue to business criteria of its requirement, one appended or refreshed criterion each, in one transaction. */
export async function traceCriteria(issueId: string, codes: readonly string[]) {
  return db.transaction((tx) => appendTracedCriteria(tx, issueId, codes));
}
