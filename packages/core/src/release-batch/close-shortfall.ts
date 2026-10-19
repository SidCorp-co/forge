// What the finish's close would refuse each roster issue for, read before the press by calling the
// close's own predicates (ISS-1337): `docs/modules/release/release-batch.md`.

import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import { db } from '../db/client.js';
import { resolveDeclaredEntryCriteria } from '../issues/entry-criteria.js';
import { entryRecordsInWords } from '../issues/entry-criteria-keys.js';
import { refuseUnshippedClose } from '../issues/merged-at.js';
import { checkTransitionEvidence } from '../issues/transition-evidence.js';
import { issueHasSession } from '../pipeline/runs-of-issue.js';
import { openQuestionIdsOn, openQuestionsFault } from '../questions/issue-coupling.js';
import { shortfallSaid } from './shortfall-words.js';

export { shortfallSaid, shortfallSentence } from './shortfall-words.js';

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
  /** The same act said on the issue's own page, whose controls are right there. */
  clearsHere: string;
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
    // The control's own words, so the sentence names the field as the page labels it.
    clears: markMergedSteps(outside),
    clearsHere: markMergedSteps(outside),
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
      // The issue's page offers an answer and nothing that voids a question (ISS-1381 r3).
      clears:
        n === 1
          ? 'Answer it in its "Decision waiting" card on the issue\'s page.'
          : 'Answer them in their "Decision waiting" cards on the issue\'s page.',
      clearsHere:
        n === 1
          ? 'Answer it in the Decision waiting card above.'
          : 'Answer them in the Decision waiting cards above.',
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
      // The page has no editor for these records, so the door is the agent that writes them (r5).
      reason: `missing ${entryRecordsInWords(unmet)}, which this project requires before a close`,
      // Open session is on the header only where the issue has a session (ISS-1228), so the line
      // names it only there and names Reopen, which every such page offers, everywhere else.
      ...((await issueHasSession(projectId, issueId))
        ? { clears: ENTRY_RECORDS_CLEAR, clearsHere: ENTRY_RECORDS_CLEAR_HERE }
        : { clears: ENTRY_RECORDS_REOPEN, clearsHere: ENTRY_RECORDS_REOPEN_HERE }),
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

export const ENTRY_RECORDS_CLEAR =
  "An agent writes them through Forge's issue tools. To start one, press Open session at the top of the issue's page.";

export const ENTRY_RECORDS_CLEAR_HERE =
  "An agent writes them through Forge's issue tools. To start one, press Open session at the top of this page.";

export const ENTRY_RECORDS_REOPEN =
  "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the issue's actions menu. The agent that takes it writes them.";

export const ENTRY_RECORDS_REOPEN_HERE =
  "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the actions menu at the top of this page. The agent that takes it writes them.";

/** One line per shortfall, the way a hold or an outcome names it: "ISS-4: It holds 1 open question. Answer it…". */
export function shortfallLine(
  displayId: string,
  shortfalls: ReadonlyArray<Pick<CloseShortfall, 'reason' | 'clears'>>,
): string {
  return `${displayId}: ${shortfalls.map(shortfallSaid).join(' ')}`;
}
