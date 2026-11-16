// Each close shortfall's words, apart from its reads, so a test can word every combination (ISS-1421 r11).

import { type MarkCommitCheck, markMergedSteps } from '@forge/contracts/mark-merged-words';
import { entryRecordsInWords } from '../issues/entry-criteria-keys.js';

type CloseShortfallCode = 'CLOSE_REQUIRES_SHIPPED' | 'OPEN_QUESTIONS' | 'ENTRY_CRITERIA_UNMET';

export interface ShortfallWords {
  code: CloseShortfallCode;
  /** In a reader's words, what stands in the way: "holds 1 open question". */
  reason: string;
  clears: string;
  /** The same act said on the issue's own page. */
  clearsHere: string;
}

export const ENTRY_RECORDS_CLEAR =
  "Press Open session at the top of the issue's page to start an agent, and it writes them.";

const ENTRY_RECORDS_CLEAR_HERE =
  'Press Open session at the top of this page to start an agent, and it writes them.';

const ENTRY_RECORDS_REOPEN =
  "This issue has no session, so use Reopen in the issue's actions menu to start an agent that writes them.";

const ENTRY_RECORDS_REOPEN_HERE =
  'This issue has no session, so use Reopen in the actions menu above to start an agent that writes them.';

export function landingShortfallWords(
  outsideGit: boolean,
  commit: MarkCommitCheck | null = 'checked',
): ShortfallWords {
  return {
    code: 'CLOSE_REQUIRES_SHIPPED',
    reason: outsideGit ? 'no mark naming where its work landed' : 'not marked merged',
    // The control's own words, so the sentence names the field as the page labels it.
    clears: markMergedSteps(outsideGit, commit),
    clearsHere: markMergedSteps(outsideGit, commit),
  };
}

/** The commit check as a refusal's details carry it; `noRepository` is round 41's key, kept. */
export function commitCheckDetails(commit: MarkCommitCheck | null): Record<string, true> {
  if (commit === 'claim') return { noRepository: true };
  if (commit === 'refused') return { repositoryUnreadable: true };
  return {};
}

export function commitCheckOf(
  details: Record<string, unknown> | null | undefined,
): MarkCommitCheck {
  if (details?.noRepository === true) return 'claim';
  if (details?.repositoryUnreadable === true) return 'refused';
  return 'checked';
}

const MARK_COMMIT_NOTE: Record<MarkCommitCheck, string> = {
  checked: '',
  claim: ' This project names no repository, so the mark may name no commit.',
  refused:
    " Forge cannot read this project's repository, so a mark naming a commit is refused; mark it naming none.",
};

/** What the unmerged refusal's caller sentence adds about the mark's commit. */
export function markCommitNote(details: Record<string, unknown> | null | undefined): string {
  return MARK_COMMIT_NOTE[commitCheckOf(details)];
}

export function openQuestionsShortfallWords(n: number): ShortfallWords {
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
    reason: `missing ${entryRecordsInWords(unmet)}`,
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
