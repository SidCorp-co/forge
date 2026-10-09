import type { IssueStatus, WaitingKind } from '../../db/issue-vocabulary.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { principalActor } from './lib.js';

/** The part of `forge_issues` `data` a status move reads. */
export interface TransitionData {
  reason?: string | undefined;
  note?: string | undefined;
  waitingKind?: WaitingKind | undefined;
  needs?: string | undefined;
  voidQuestions?: string | undefined;
}

/**
 * One status move off `data`, the same for `update` and `transition`. Its answer carries
 * `rewritten`, which both actions hand back so a caller reads what a rule stored (ISS-1365).
 */
export function transitionByData(
  issue: Parameters<typeof transitionIssueStatus>[0],
  status: IssueStatus,
  principal: Parameters<typeof principalActor>[0],
  data: TransitionData | undefined,
) {
  return transitionIssueStatus(issue, status, principalActor(principal), {
    transitionReason: data?.reason ?? data?.note,
    waitingKind: data?.waitingKind,
    needs: data?.needs,
    voidQuestions: data?.voidQuestions,
  });
}
