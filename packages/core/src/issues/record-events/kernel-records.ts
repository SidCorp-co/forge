import { VERDICTS_WAIVED_FIELD } from '@forge/contracts/delivery-policy';
import { PARK_STATUSES } from '@forge/contracts/issue-machine';
import type { Tx } from '../../db/client.js';
import type { IssueStatus, WaitingKind } from '../../db/schema.js';
import type { WorkStep } from '../../db/schema-issue-work-state.js';
import type { Actor } from '../activity.js';
import { actorAgency } from '../actor-agency.js';
import type { TransitionWriteInput } from '../apply-transition.js';
import { type RecordEventField, writeKernelRecord } from './store.js';

export interface MoveRecord {
  readonly issueId: string;
  readonly actor: Actor;
  readonly from: IssueStatus;
  readonly to: IssueStatus;
  readonly reopenCount: number;
  readonly step: WorkStep | null;
  readonly reason: string | null;
  readonly recovery: boolean;
  readonly leftStatus: IssueStatus | null;
  readonly waitingKind: WaitingKind | null;
  readonly needs: string | null;
  /** The move passed the verdict gate only because the project does not require verdicts. */
  readonly verdictsWaived?: boolean;
}

export function moveOf(
  input: TransitionWriteInput,
  reopenCount: number,
  verdictsWaived = false,
): MoveRecord {
  const { actor, options, fromStatus, toStatus } = input;
  return {
    issueId: input.issue.id,
    actor: { type: actor.type, id: actor.id, agency: actorAgency(actor) },
    from: fromStatus,
    to: toStatus,
    reopenCount,
    step: input.step,
    reason: options.transitionReason?.trim() || options.reason || null,
    recovery: input.recovering,
    leftStatus: PARK_STATUSES.includes(fromStatus) ? input.leftStatus : fromStatus,
    waitingKind: toStatus === 'needs_info' ? (options.waitingKind ?? null) : null,
    needs: options.needs?.trim() || null,
    verdictsWaived,
  };
}

const field = (key: string, value: string | null | undefined): RecordEventField[] =>
  value === null || value === undefined || value === '' ? [] : [{ key, value }];

export function transitionRecordFields(move: MoveRecord): RecordEventField[] {
  return [
    { key: 'from', value: move.from },
    { key: 'to', value: move.to },
    { key: 'reopen-count', value: String(move.reopenCount) },
    ...field('step', move.step),
    ...field('reason', move.reason),
    ...field('recovery', move.recovery ? 'true' : null),
    ...field(VERDICTS_WAIVED_FIELD, move.verdictsWaived ? 'true' : null),
  ];
}

export function parkRecordFields(move: MoveRecord): RecordEventField[] {
  return [
    { key: 'status', value: move.to },
    ...field('kind', move.to === 'needs_info' ? move.waitingKind : null),
    ...field('why', move.reason),
    ...field('left-status', move.leftStatus),
    ...field('needs', move.needs),
  ];
}

/**
 * What a move adds to its `kernel_transitions` row and outbox event, on the move's own transaction,
 * and only where that row has no column for it: a park's why, kind and needs (`record.park`, read
 * by the park view), and a verdict gate passed only because the project waives verdicts
 * (`record.transition` naming `verdicts-waived`). Any other move writes no record here.
 */
export async function recordMove(tx: Tx, move: MoveRecord): Promise<void> {
  if (move.verdictsWaived) {
    await writeKernelRecord(tx, {
      issueId: move.issueId,
      actor: move.actor,
      kind: 'transition',
      fields: transitionRecordFields(move),
    });
  }
  if (!PARK_STATUSES.includes(move.to)) return;
  await writeKernelRecord(tx, {
    issueId: move.issueId,
    actor: move.actor,
    kind: 'park',
    fields: parkRecordFields(move),
  });
}
