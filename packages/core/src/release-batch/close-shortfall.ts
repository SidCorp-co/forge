// What the finish's close would refuse each roster issue for, read before the press by calling the
// close's own predicates (ISS-1337): `docs/modules/release/release-batch.md`.

import { db } from '../db/client.js';
import { resolveDeclaredEntryCriteria } from '../issues/entry-criteria.js';
import { refuseUnshippedClose } from '../issues/merged-at.js';
import { checkTransitionEvidence } from '../issues/transition-evidence.js';
import { openQuestionIdsOn, openQuestionsFault } from '../questions/issue-coupling.js';

export type CloseShortfallCode =
  | 'CLOSE_REQUIRES_SHIPPED'
  | 'OPEN_QUESTIONS'
  | 'ENTRY_CRITERIA_UNMET';

export interface CloseShortfall {
  /** The code the close itself would refuse with. */
  code: CloseShortfallCode;
  /** In a reader's words, what stands in the way: "holds 1 open question". */
  reason: string;
  /** The act that clears it. */
  clears: string;
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
    code: 'CLOSE_REQUIRES_SHIPPED',
    reason: outside ? 'no mark naming where its work landed' : 'not marked merged',
    clears: outside
      ? 'Mark it merged with its landing: the live URL, CMS entry or storefront resource the work now is.'
      : 'Mark it merged where its work landed.',
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
    const n = asked.length;
    found.push({
      code: 'OPEN_QUESTIONS',
      reason: `holds ${n} open question${n === 1 ? '' : 's'}`,
      clears: `Answer ${n === 1 ? 'it' : 'them'}, or void ${n === 1 ? 'it' : 'them'} with the reason ${n === 1 ? 'it' : 'they'} died with the work.`,
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
      code: 'ENTRY_CRITERIA_UNMET',
      reason: `missing what this project requires to close: ${unmet.join(', ')}`,
      clears: 'Write each missing record on the issue.',
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

/** One line per shortfall, the way a hold or an outcome names it: "ISS-4: holds 1 open question. Answer it…". */
export function shortfallLine(
  displayId: string,
  shortfalls: ReadonlyArray<Pick<CloseShortfall, 'reason' | 'clears'>>,
): string {
  return `${displayId}: ${shortfalls.map((s) => `${s.reason}. ${s.clears}`).join(' ')}`;
}
