import { ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { edgeBetween, exitsOf } from '@forge/contracts/state-machine';
import type { IssueStatus } from '../db/schema.js';
import type { RefusalError } from '../lib/refusal.js';
import { transitionRefused } from './apply-transition.js';
import { guideRef } from './ports.js';

const RECOVERY_EXITS = exitsOf(ISSUE_MACHINE, 'in_progress', true);
const RECOVERY_TARGETS = RECOVERY_EXITS.map((t) => `\`${t}\``).join(', ');
const isRecoveryEdge = (from: IssueStatus, to: IssueStatus) =>
  edgeBetween(ISSUE_MACHINE, from, to, true) !== null;

// REQ-2 BC-10: `recovery` reaches only the kernel hand-back of an `in_progress` issue nothing
// holds; `apply-transition.ts` refuses it while anything does, so a live holder is never displaced.
export function refuseOffRecoveryEdge(from: IssueStatus, to: IssueStatus): void {
  if (isRecoveryEdge(from, to)) return;
  throw transitionRefused(
    'ILLEGAL_TRANSITION',
    `\`recovery: true\` names the hand-back of an \`in_progress\` issue nothing holds, to ${RECOVERY_TARGETS} (${guideRef('pipeline-and-issue-lifecycle')}). \`${from}\` → \`${to}\` is not one; send the move without \`recovery\`.`,
    { from, to, recovery: true, recoveryEdges: { in_progress: RECOVERY_EXITS } },
  );
}

export function withRecoveryHint(
  err: RefusalError,
  from: IssueStatus,
  to: IssueStatus,
  recovery: boolean | undefined,
): RefusalError {
  const [refusal] = err.refusals;
  if (recovery || refusal?.code !== 'ILLEGAL_TRANSITION' || !isRecoveryEdge(from, to)) return err;
  return transitionRefused(
    refusal.code,
    `${refusal.detail} An \`in_progress\` issue nothing holds any more is handed back to ${RECOVERY_TARGETS} by the recovery move: once its holder has let it go, send \`recovery: true\` with the reason (a judge's failed criteria go back to \`reopen\`).`,
    refusal,
  );
}
