import { db } from '../../db/client.js';
import { type CriterionInput, listCriteria, putCriteria } from './store.js';
import { withCurrentDrafts } from './storefront-draft.js';
import { recordVerdict } from './verdict-record.js';

/** An issue's live criteria with their latest verdicts and the storefront's current drafts. */
export async function readCriteriaWithDrafts(issue: { id: string; projectId: string }) {
  return withCurrentDrafts(issue.projectId, await listCriteria(db, issue.id));
}

/** Replaces an issue's criteria in one transaction. */
export async function replaceCriteria(issueId: string, criteria: readonly CriterionInput[]) {
  return db.transaction((tx) => putCriteria(tx, issueId, criteria));
}

/** Records one verdict in its own transaction. */
export async function addVerdict(args: Parameters<typeof recordVerdict>[1]) {
  return db.transaction((tx) => recordVerdict(tx, args));
}
