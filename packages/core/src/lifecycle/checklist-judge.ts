/**
 * The kernel's own guard on an edge naming a checklist (`@forge/contracts/checklists:CHECKLIST_GUARD`),
 * which `transition.ts:transition` runs under the row lock whatever door the move came through: the
 * mover's answers are parsed, the item's own record is read through the move's transaction, and a
 * blocking gap refuses the move naming its question. A move a gate refused, the checklist or a move
 * check (`@forge/contracts/move-gates`), is recorded here, in `kernel_refused_moves`; a passed one is
 * recorded with its answers and its gates on `kernel_transitions`.
 */

import { CHECKLISTS, type ChecklistId, isChecklistId } from '@forge/contracts/checklist-registry';
import {
  type ChecklistEvaluation,
  checklistRefusals,
  type DerivedAnswer,
  evaluateChecklist,
  parseAnswers,
  type RecordAnswers,
  waivedEvaluation,
} from '@forge/contracts/checklists';
import {
  gatesConfigSchema,
  isGateId,
  type ResolvedGate,
  resolveGate,
} from '@forge/contracts/gate-profiles';
import { ISSUE_STATUS_LABELS } from '@forge/contracts/issue-vocabulary';
import type { MachineEntity, MachineOf, StateOf } from '@forge/contracts/machines';
import type { Gate } from '@forge/contracts/move-gates';
import type { MachineEdge } from '@forge/contracts/state-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kernelRefusedMoves } from '../db/schema.js';
import { gateRefusals } from '../lib/gated.js';
import type { Refusal } from '../lib/refusal.js';
import type { MoverColumns, PriorRow, Tx } from './transition.js';

/**
 * What a move along an edge naming a checklist carries: the mover's answers as the door received
 * them, which the kernel parses, and the reader of what the item's own record answers, which runs
 * under the lock through the move's transaction and reads nothing else.
 */
export interface MoveChecklist<E extends MachineEntity> {
  answers?: unknown;
  /** Answers a rule gave from the mover's others, recorded as derived by it (`checklists.ts:DerivedAnswer`). */
  derived?: Readonly<Record<string, DerivedAnswer>>;
  record: (input: { tx: Tx; row: PriorRow<E>; checklist: ChecklistId }) => Promise<RecordAnswers>;
  /**
   * A decision moves over the blocking gaps: the move passes, each gap recorded as a `waived` answer
   * (`checklists.ts:waivedEvaluation`). The door asks who may decide before it sets this.
   */
  waive?: boolean;
  /** Told the evaluation the move is recorded with, once the checklist passed or was waived. */
  judged?: (evaluation: ChecklistEvaluation) => void;
}

/** A move a gate refused, with every refusal it answered. */
export interface RefusedMove {
  entityId: string;
  from: string;
  gate: Pick<Gate, 'id' | 'version'>;
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
      gate: m.gate.id,
      gateVersion: m.gate.version,
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
  const evaluation = evaluateChecklist(checklist, {
    given: parsed.answers,
    record,
    ...(move.checklist.derived ? { derived: move.checklist.derived } : {}),
  });
  if (evaluation.complete || move.checklist.waive) {
    const recorded = evaluation.complete ? evaluation : waivedEvaluation(evaluation);
    move.checklist.judged?.(recorded);
    return { evaluation: recorded };
  }
  const gate = await checklistGateOf(tx, machine.entity, row, id);
  if (gate.mode === 'enforce') {
    return { refusals: gateRefusals(gate, checklistRefusals(evaluation)) };
  }
  const recorded = waivedEvaluation(evaluation, `gate:${gate.id}:${gate.profile}`);
  move.checklist.judged?.(recorded);
  return { evaluation: recorded };
}

/** The table each entity whose machine names a checklist is stored in, read for the row's project. */
const CHECKLIST_ENTITY_TABLES: Partial<Record<MachineEntity, string>> = {
  issue: 'issues',
  requirement: 'requirements',
  feedback: 'feedback',
  suggestion: 'suggestions',
  workflow_design: 'project_workflows',
};

/**
 * The checklist's gate on the row's project (REQ-76): a checklist gate is set by the profile or an
 * override alone, never by another switch, so only the document's `gates` is read, through the move's
 * own transaction. The row a move is judged on carries its id and status only, so its project is read
 * from the entity's own table; an entity with no table here is refused by name, never gated as a guess.
 */
async function checklistGateOf(
  tx: Tx,
  entity: MachineEntity,
  row: PriorRow<MachineEntity>,
  id: ChecklistId,
): Promise<ResolvedGate> {
  if (!isGateId(id)) throw new Error(`transition: checklist \`${id}\` is in no gate catalog entry`);
  const table = CHECKLIST_ENTITY_TABLES[entity];
  if (!table) {
    throw new Error(
      `transition: ${entity} names checklist \`${id}\`, and no table is declared to read its project's gate profile from`,
    );
  }
  const [held] = (await tx.execute(sql`
    SELECT d.document -> 'gates' AS gates
      FROM ${sql.raw(table)} t
      JOIN project_config_documents d ON d.project_id = t.project_id
     WHERE t.id = ${row.id}::uuid
  `)) as unknown as { gates: unknown }[];
  const parsed = held?.gates == null ? null : gatesConfigSchema.safeParse(held.gates);
  if (parsed && !parsed.success) {
    throw new Error(
      `transition: ${entity} ${row.id}'s project gates no longer parse; nothing is guessed`,
    );
  }
  return resolveGate(parsed?.data, id, 'enforce');
}

/**
 * A status as a person reads it: an issue's by its badge label ("Needs info"); the requirement and
 * feedback statuses are single plain words already.
 */
function statusWords(entity: MachineEntity, status: string): string {
  const label =
    entity === 'issue'
      ? ISSUE_STATUS_LABELS[status as keyof typeof ISSUE_STATUS_LABELS]
      : undefined;
  return `"${label ?? status}"`;
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
      detail: `Moving this ${entity} from ${statusWords(entity, from)} to ${statusWords(entity, to)} asks no checklist questions, so it takes no answers. Send the move without answers.`,
    },
  ];
}
