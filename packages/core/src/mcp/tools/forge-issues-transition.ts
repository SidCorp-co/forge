import type { IssueStatus, WaitingKind } from '../../db/issue-vocabulary.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { noOpSentence } from '../../issues/close-substitution.js';
import { TransitionError } from '../../issues/transition-error.js';
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
    transitionReason: data?.reason?.trim() || data?.note?.trim() || undefined,
    waitingKind: data?.waitingKind,
    needs: data?.needs,
    voidQuestions: data?.voidQuestions,
  });
}

/** The `data` keys a status move reads; any other key is a write of its own. */
const MOVE_KEYS: ReadonlySet<string> = new Set([
  'status',
  'reason',
  'note',
  'waitingKind',
  'needs',
  'voidQuestions',
]);

/**
 * `update` sent with the status the issue already holds is refused as the transition door refuses
 * it, before anything else it carried is written: an answer of `updated` that moved nothing reads
 * as a move made (ISS-1229 r10, judge-23). Kernel input is not normalized.
 */
export function refuseUnchangedStatus(
  issue: { projectId: string; status: IssueStatus },
  data: Record<string, unknown>,
): void {
  const status = data.status;
  if (status !== issue.status) return;
  const same = noOpSentence({
    projectId: issue.projectId,
    requested: issue.status,
    parked: issue.status,
    final: issue.status,
  });
  const rest = Object.keys(data).some((k) => !MOVE_KEYS.has(k) && data[k] !== undefined);
  const detail = rest
    ? `${same}. Nothing else this update carried was written: send it again without \`data.status\` to write the rest`
    : same;
  throw new TransitionError('NO_OP', detail, { status: issue.status });
}
