/**
 * The kernel's own guard on an edge naming a checklist (`@forge/contracts/checklists:CHECKLIST_GUARD`),
 * which `transition.ts:transition` runs under the row lock whatever door the move came through: the
 * mover's answers are parsed, the item's own record is read through the move's transaction, and a
 * blocking gap refuses the move naming its question. A refused move is recorded here, in
 * `kernel_refused_moves`; a passed one is recorded with its answers on `kernel_transitions`.
 */

import { CHECKLISTS, type ChecklistId, isChecklistId } from '@forge/contracts/checklist-registry';
import {
  type ChecklistEvaluation,
  checklistRefusals,
  evaluateChecklist,
  parseAnswers,
  type RecordAnswers,
} from '@forge/contracts/checklists';
import type { MachineEntity, MachineOf, StateOf } from '@forge/contracts/machines';
import type { MachineEdge } from '@forge/contracts/state-machine';
import { db } from '../db/client.js';
import { kernelRefusedMoves } from '../db/schema.js';
import type { Refusal } from '../lib/refusal.js';
import type { MoverColumns, PriorRow, Tx } from './transition.js';

/**
 * What a move along an edge naming a checklist carries: the mover's answers as the door received
 * them, which the kernel parses, and the reader of what the item's own record answers, which runs
 * under the lock through the move's transaction and reads nothing else.
 */
export interface MoveChecklist<E extends MachineEntity> {
  answers?: unknown;
  record: (input: { tx: Tx; row: PriorRow<E>; checklist: ChecklistId }) => Promise<RecordAnswers>;
}

/** A move refused along an edge naming a checklist, with every refusal it answered. */
export interface RefusedMove {
  entityId: string;
  from: string;
  checklist: ChecklistId;
  refusals: Refusal[];
}

/**
 * Written on a connection of its own, after the move's transaction: a caller that throws the
 * refusal rolls its own transaction back, and the record of the refused move must outlive that.
 * The table has no foreign key, so the row lock the caller may still hold does not wait on it.
 */
export async function recordRefusedMoves<E extends MachineEntity>(
  machine: MachineOf<E>,
  to: StateOf<E>,
  mover: MoverColumns,
  moves: readonly RefusedMove[],
): Promise<void> {
  if (moves.length === 0) return;
  await db.insert(kernelRefusedMoves).values(
    moves.map((m) => ({
      entity: machine.entity,
      entityId: m.entityId,
      fromStatus: m.from,
      toStatus: to,
      machineVersion: machine.version,
      checklist: m.checklist,
      checklistVersion: CHECKLISTS[m.checklist].version,
      refusals: m.refusals,
      ...mover,
    })),
  );
}

export type ChecklistJudgement = { evaluation: ChecklistEvaluation } | { refusals: Refusal[] };

/** The checklist the edge names, judged against the mover's answers and the item's own record. */
export async function judgeChecklist<E extends MachineEntity>(
  tx: Tx,
  machine: MachineOf<E>,
  edge: MachineEdge<StateOf<E>>,
  row: PriorRow<E>,
  move: { checklist?: MoveChecklist<E> | undefined; source: string },
): Promise<ChecklistJudgement> {
  const id = edge.checklist;
  if (id === undefined || !isChecklistId(id)) {
    throw new Error(
      `transition: ${machine.entity} \`${edge.from}\` → \`${edge.to}\` names the checklist guard, and no registered checklist`,
    );
  }
  if (!move.checklist) {
    throw new Error(
      `transition: ${machine.entity} \`${edge.from}\` → \`${edge.to}\` asks checklist \`${id}\`, and ${move.source} supplied no reader of the item's record`,
    );
  }
  const checklist = CHECKLISTS[id];
  const parsed = parseAnswers(checklist, move.checklist.answers);
  if (!parsed.ok) return { refusals: parsed.refusals };
  const record = await move.checklist.record({ tx, row, checklist: id });
  const evaluation = evaluateChecklist(checklist, { given: parsed.answers, record });
  if (!evaluation.complete) return { refusals: checklistRefusals(evaluation) };
  return { evaluation };
}

/** Answers sent to a move whose edge asks no checklist, refused by name; none sent, no refusal. */
export function answersToNoChecklist(
  entity: MachineEntity,
  from: string,
  to: string,
  answers: unknown,
): Refusal[] {
  const carried =
    answers !== undefined &&
    answers !== null &&
    (typeof answers !== 'object' || Object.keys(answers).length > 0);
  if (!carried) return [];
  return [
    {
      code: 'CHECKLIST_ANSWER_INVALID',
      path: '/answers',
      detail: `The move ${entity} \`${from}\` → \`${to}\` asks no checklist, so it takes no answers. Send the move without them.`,
    },
  ];
}
