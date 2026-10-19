// What the finish's close would refuse each roster issue for, read before the press by calling the
// close's own predicates (ISS-1337): `docs/modules/release/release-batch.md`.

import { db } from '../db/client.js';
import { resolveDeclaredEntryCriteria } from '../issues/entry-criteria.js';
import { refuseUnshippedClose } from '../issues/merged-at.js';
import { checkTransitionEvidence } from '../issues/transition-evidence.js';
import { issueHasSession } from '../pipeline/runs-of-issue.js';
import { openQuestionIdsOn, openQuestionsFault } from '../questions/issue-coupling.js';
import {
  entryRecordsShortfallWords,
  landingShortfallWords,
  openQuestionsShortfallWords,
  type ShortfallWords,
  shortfallSaid,
} from './shortfall-words.js';

export { ENTRY_RECORDS_CLEAR, shortfallSaid, shortfallSentence } from './shortfall-words.js';

export interface CloseShortfall extends ShortfallWords {
  /** The close's own sentence, unchanged. */
  detail: string;
  details: Record<string, unknown>;
}

/** Each issue that has a shortfall, mapped to every shortfall it has; an issue whose close stands is absent. */
export type CloseShortfalls = Map<string, CloseShortfall[]>;

function landingShortfallOf(refusal: {
  detail: string;
  details: Record<string, unknown>;
}): CloseShortfall {
  const outside = refusal.details.shape === 'outside_git';
  return {
    ...landingShortfallWords(outside),
    detail: refusal.detail,
    details: { ...refusal.details, shape: outside ? 'outside_git' : 'git' },
  };
}

async function shortfallsOf(
  projectId: string,
  issueId: string,
  declared: Awaited<ReturnType<typeof resolveDeclaredEntryCriteria>>,
): Promise<CloseShortfall[]> {
  const found: CloseShortfall[] = [];
  const unshipped = await refuseUnshippedClose(db, { issueId, toStatus: 'closed' });
  if (unshipped) found.push(landingShortfallOf(unshipped));

  const asked = await openQuestionIdsOn(db, issueId);
  if (asked.length > 0) {
    const fault = openQuestionsFault(asked, 'closed');
    found.push({
      ...openQuestionsShortfallWords(asked.length),
      detail: fault.detail,
      details: fault.details,
    });
  }

  // `agent` is the stricter agency, and no rule a close reads exempts the other one.
  const violation = await checkTransitionEvidence({
    issue: { id: issueId, projectId },
    toStatus: 'closed',
    agency: 'agent',
    skip: false,
    declaredCriteria: declared,
  });
  if (violation?.code === 'ENTRY_CRITERIA_UNMET') {
    const unmet = Array.isArray(violation.details.unmet)
      ? (violation.details.unmet as string[])
      : [];
    found.push({
      ...entryRecordsShortfallWords(unmet, await issueHasSession(projectId, issueId)),
      detail: violation.detail,
      details: violation.details,
    });
  }
  return found;
}

/**
 * The close's refusals for each named issue, as they stand now. A read that throws is the caller's
 * to report as a check it could not make, never an issue whose close stands.
 */
export async function rosterCloseShortfalls(
  projectId: string,
  issueIds: readonly string[],
): Promise<CloseShortfalls> {
  const out: CloseShortfalls = new Map();
  if (issueIds.length === 0) return out;
  const declared = await resolveDeclaredEntryCriteria(projectId, 'closed');
  for (const issueId of issueIds) {
    const found = await shortfallsOf(projectId, issueId, declared);
    if (found.length > 0) out.set(issueId, found);
  }
  return out;
}

/** One line per shortfall, the way a hold or an outcome names it: "ISS-4: It holds 1 open question. Answer it…". */
export function shortfallLine(
  displayId: string,
  shortfalls: ReadonlyArray<Pick<CloseShortfall, 'reason' | 'clears'>>,
): string {
  return `${displayId}: ${shortfalls.map(shortfallSaid).join(' ')}`;
}
