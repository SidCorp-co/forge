import type { IssueStatus } from '../db/schema.js';
import { isRecoveryEdge, RECOVERY_EDGES } from '../pipeline/state-machine.js';
import { TransitionError } from './apply-transition.js';

const RECOVERY_TARGETS = (RECOVERY_EDGES.in_progress ?? []).map((t) => `\`${t}\``).join(', ');

// cm:guard REQ-2 BC-10: `recovery` reaches only the kernel hand-back of an `in_progress` issue nothing
// holds; `apply-transition.ts` refuses it while anything does, so a live holder is never displaced.
export function refuseOffRecoveryEdge(from: IssueStatus, to: IssueStatus): void {
  if (isRecoveryEdge(from, to)) return;
  throw new TransitionError(
    'ILLEGAL_TRANSITION',
    `\`recovery: true\` names the hand-back of an \`in_progress\` issue nothing holds, to ${RECOVERY_TARGETS} (REQ-2 BC-10, workflow issue-lifecycle). \`${from}\` → \`${to}\` is not one; send the move without \`recovery\`.`,
    { from, to, recovery: true, recoveryEdges: RECOVERY_EDGES },
  );
}

export function withRecoveryHint(
  err: TransitionError,
  from: IssueStatus,
  to: IssueStatus,
  recovery: boolean | undefined,
): TransitionError {
  if (recovery || err.code !== 'ILLEGAL_TRANSITION' || !isRecoveryEdge(from, to)) return err;
  return new TransitionError(
    err.code,
    `${err.detail} An \`in_progress\` issue nothing holds any more is handed back to ${RECOVERY_TARGETS} by the recovery move: once its holder has let it go, send \`recovery: true\` with the reason (a judge's failed criteria go back to \`reopen\`).`,
    err.details,
  );
}
