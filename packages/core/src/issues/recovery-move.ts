import { z } from 'zod';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { guideRef } from '../guides/guide-ref.js';
import { isRecoveryEdge, RECOVERY_EDGES } from '../pipeline/state-machine.js';
import type { TransitionActor } from './actor-agency.js';
import {
  TransitionError,
  type TransitionIssueRow,
  transitionIssueStatus,
} from './apply-transition.js';

const RECOVERY_TARGETS = (RECOVERY_EDGES.in_progress ?? []).map((t) => `\`${t}\``).join(', ');

// cm:guard REQ-2 BC-10: `recovery` reaches only the kernel hand-back of an `in_progress` issue nothing
// holds; `apply-transition.ts` refuses it while anything does, so a live holder is never displaced.
export function refuseOffRecoveryEdge(from: IssueStatus, to: IssueStatus): void {
  if (isRecoveryEdge(from, to)) return;
  throw new TransitionError(
    'ILLEGAL_TRANSITION',
    `\`recovery: true\` names the hand-back of an \`in_progress\` issue nothing holds, to ${RECOVERY_TARGETS} (${guideRef('pipeline-and-issue-lifecycle')}). \`${from}\` → \`${to}\` is not one; send the move without \`recovery\`.`,
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

export const recoveryField = z
  .literal(true)
  .optional()
  .describe(
    `With \`transition\`: the kernel hand-back of an \`in_progress\` issue nothing holds any more, to \`open\`, \`approved\` or \`reopen\` (${guideRef('pipeline-and-issue-lifecycle')}). A judge that failed a criterion lets go of the issue, then sends \`status: reopen\`, \`recovery: true\` and the failed criteria as \`reason\`. Refused while anything holds the issue, and on any other move.`,
  );

export async function transitionNamingRecovery(
  issue: TransitionIssueRow,
  target: IssueStatus,
  actor: TransitionActor,
  data:
    | {
        reason?: string | undefined;
        note?: string | undefined;
        waitingKind?: WaitingKind | undefined;
        needs?: string | undefined;
        voidQuestions?: string | undefined;
        recovery?: true | undefined;
      }
    | undefined,
): Promise<void> {
  const recovery = data?.recovery === true;
  try {
    if (recovery) refuseOffRecoveryEdge(issue.status, target);
    await transitionIssueStatus(issue, target, actor, {
      transitionReason: data?.reason ?? data?.note,
      waitingKind: data?.waitingKind,
      needs: data?.needs,
      voidQuestions: data?.voidQuestions,
      ...(recovery ? { recovery } : {}),
    });
  } catch (err) {
    if (err instanceof TransitionError) throw withRecoveryHint(err, issue.status, target, recovery);
    throw err;
  }
}
