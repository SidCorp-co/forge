// What each close shortfall says, apart from the reads that find it, so every combination a project
// can require is worded and measured without a database (ISS-1421 r11, criterion 133).

import { markMergedSteps } from '@forge/contracts/mark-merged-words';
import { entryRecordsInWords } from '../issues/entry-criteria-keys.js';

type CloseShortfallCode =
  | 'CLOSE_REQUIRES_SHIPPED'
  | 'OPEN_QUESTIONS'
  | 'ENTRY_CRITERIA_UNMET';

/** A shortfall's words: its reason, the act that clears it, and that act said on the issue's page. */
export interface ShortfallWords {
  code: CloseShortfallCode;
  /** In a reader's words, what stands in the way: "holds 1 open question". */
  reason: string;
  clears: string;
  /** The same act said on the issue's own page, whose controls are right there. */
  clearsHere: string;
}

export const ENTRY_RECORDS_CLEAR =
  "An agent writes them through Forge's issue tools. To start one, press Open session at the top of the issue's page.";

const ENTRY_RECORDS_CLEAR_HERE =
  "An agent writes them through Forge's issue tools. To start one, press Open session at the top of this page.";

const ENTRY_RECORDS_REOPEN =
  "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the issue's actions menu. The agent that takes it writes them.";

const ENTRY_RECORDS_REOPEN_HERE =
  "An agent writes them through Forge's issue tools. This issue has no session to open, so use Reopen in the actions menu at the top of this page. The agent that takes it writes them.";

export function landingShortfallWords(outsideGit: boolean): ShortfallWords {
  return {
    code: 'CLOSE_REQUIRES_SHIPPED',
    reason: outsideGit ? 'no mark naming where its work landed' : 'not marked merged',
    // The control's own words, so the sentence names the field as the page labels it.
    clears: markMergedSteps(outsideGit),
    clearsHere: markMergedSteps(outsideGit),
  };
}

export function openQuestionsShortfallWords(n: number): ShortfallWords {
  // The issue's page offers an answer and nothing that voids a question (ISS-1381 r3).
  return {
    code: 'OPEN_QUESTIONS',
    reason: `holds ${n} open question${n === 1 ? '' : 's'}`,
    clears:
      n === 1
        ? 'Answer it in its "Decision waiting" card on the issue\'s page.'
        : 'Answer them in their "Decision waiting" cards on the issue\'s page.',
    clearsHere:
      n === 1
        ? 'Answer it in the Decision waiting card above.'
        : 'Answer them in the Decision waiting cards above.',
  };
}

/**
 * The page has no editor for these records, so the door is the agent that writes them (r5). Open
 * session is on the header only where the issue has a session (ISS-1228), so the act names it only
 * there and names Reopen, which every such page offers, everywhere else.
 */
export function entryRecordsShortfallWords(
  unmet: readonly string[],
  hasSession: boolean,
): ShortfallWords {
  return {
    code: 'ENTRY_CRITERIA_UNMET',
    reason: `missing ${entryRecordsInWords(unmet)}, which this project requires before a close`,
    ...(hasSession
      ? { clears: ENTRY_RECORDS_CLEAR, clearsHere: ENTRY_RECORDS_CLEAR_HERE }
      : { clears: ENTRY_RECORDS_REOPEN, clearsHere: ENTRY_RECORDS_REOPEN_HERE }),
  };
}

/** A shortfall's reason ("not marked merged", "holds 1 open question") as a sentence of its own. */
export function shortfallSentence(reason: string): string {
  const verb = /^(holds|has) /.test(reason) ? 'It' : /^no /.test(reason) ? 'It has' : 'It is';
  return `${verb} ${reason}.`;
}

export function shortfallSaid(s: { reason: string; clears: string }): string {
  return `${shortfallSentence(s.reason)} ${s.clears}`;
}
