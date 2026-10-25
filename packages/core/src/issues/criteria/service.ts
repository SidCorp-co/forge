import { db } from '../../db/client.js';
import { criterionRoutesOf } from '../design-record.js';
import { countingOf } from './counting.js';
import { keptProbesOf } from './probes.js';
import { type CriterionInput, listCriteria, listRetiredCriteria, putCriteria } from './store.js';
import { withCurrentDrafts } from './storefront-draft.js';
import { appendTracedCriteria } from './tie.js';
import { recordVerdict } from './verdict-record.js';

/**
 * An issue's live criteria with their latest verdicts and the storefront's current drafts, each with
 * the class its design records, the judge that class routes it to (null where none classes it) and
 * the probe it keeps (null where it keeps none), and whether a release counts the verdict it stands
 * on (`counts`, `counting.ts:countingOf`), saying why where it does not. A latest pass counted only
 * under the builder-pass cutover says so (`countedUnderCutover`), never one that does not count.
 */
export async function readCriteriaWithDrafts(issue: { id: string; projectId: string }) {
  const criteria = await withCurrentDrafts(issue.projectId, await listCriteria(db, issue.id));
  const ids = criteria.map((c) => c.id);
  const [routes, probes, counting] = await Promise.all([
    criterionRoutesOf(ids),
    keptProbesOf(db, ids),
    countingOf(db, issue),
  ]);
  return criteria.map((c) => ({
    ...c,
    latest: c.latest
      ? { ...c.latest, countedUnderCutover: counting.get(c.n)?.underCutover === c.latest.id }
      : null,
    counts: {
      counted: counting.get(c.n)?.counted ?? false,
      why: counting.get(c.n)?.why ?? null,
    },
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

/** Replaces an issue's criteria in one transaction. */
export async function replaceCriteria(issueId: string, criteria: readonly CriterionInput[]) {
  return db.transaction((tx) => putCriteria(tx, issueId, criteria));
}

/** Records one verdict in its own transaction. */
export async function addVerdict(args: Parameters<typeof recordVerdict>[1]) {
  return db.transaction((tx) => recordVerdict(tx, args));
}

/** Ties the issue to business criteria of its requirement, one appended or refreshed criterion each, in one transaction. */
export async function traceCriteria(issueId: string, codes: readonly string[]) {
  return db.transaction((tx) => appendTracedCriteria(tx, issueId, codes));
}
