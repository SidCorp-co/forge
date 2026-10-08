import type { ChecklistAnswer } from '@forge/contracts/checklists';
import { type GatedMoveStanding, gatedMoveStanding } from '@forge/contracts/checklists';
import type { MachineEntity, MachineOf } from '@forge/contracts/machines';
import type { Refusal } from '@forge/contracts/refusal';
import { and, desc, eq, or } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { kernelRefusedMoves, kernelTransitions } from '../db/schema.js';

/** One move along an edge that names a checklist now, passed or refused, as the kernel recorded it. */
export interface GatedMove {
  at: string;
  from: string | null;
  to: string;
  standing: GatedMoveStanding;
  /** The checklist that judged it, or null for a move recorded before its edge had one. */
  checklist: { id: string; version: number } | null;
  answers: ChecklistAnswer[] | null;
  refusals: Refusal[] | null;
  actor: { type: string; agency: string; id: string | null };
  source: string;
}

type Reader = Pick<Tx, 'select'>;

/**
 * An item's moves along the edges of its machine that name a checklist, newest first: each passed
 * move with the checklist and answers it was judged by, or `no_checklist` where it was recorded
 * before (never counted as passed), and each refused one.
 */
export async function gatedMovesOf<E extends MachineEntity>(
  exec: Reader,
  machine: MachineOf<E>,
  entityId: string,
): Promise<GatedMove[]> {
  const gated = machine.edges.filter((e) => 'checklist' in e && e.checklist !== undefined);
  if (gated.length === 0) return [];
  const onGatedEdge = or(
    ...gated.map((e) =>
      and(eq(kernelTransitions.fromStatus, e.from), eq(kernelTransitions.toStatus, e.to)),
    ),
  );
  const passed = await exec
    .select()
    .from(kernelTransitions)
    .where(
      and(
        eq(kernelTransitions.entity, machine.entity),
        eq(kernelTransitions.entityId, entityId),
        onGatedEdge,
      ),
    )
    .orderBy(desc(kernelTransitions.createdAt));
  const refused = await exec
    .select()
    .from(kernelRefusedMoves)
    .where(
      and(eq(kernelRefusedMoves.entity, machine.entity), eq(kernelRefusedMoves.entityId, entityId)),
    )
    .orderBy(desc(kernelRefusedMoves.createdAt));
  const moves: GatedMove[] = [
    ...passed.map((r) => ({
      at: r.createdAt.toISOString(),
      from: r.fromStatus,
      to: r.toStatus,
      standing: gatedMoveStanding({ refused: false, checklistVersion: r.checklistVersion }),
      checklist:
        r.checklist !== null && r.checklistVersion !== null
          ? { id: r.checklist, version: r.checklistVersion }
          : null,
      answers: r.checklistAnswers ?? null,
      refusals: null,
      actor: { type: r.actorType, agency: r.actorAgency, id: r.actorId },
      source: r.source,
    })),
    ...refused.map((r) => ({
      at: r.createdAt.toISOString(),
      from: r.fromStatus,
      to: r.toStatus,
      standing: gatedMoveStanding({ refused: true, checklistVersion: r.checklistVersion }),
      checklist: { id: r.checklist, version: r.checklistVersion },
      answers: null,
      refusals: r.refusals,
      actor: { type: r.actorType, agency: r.actorAgency, id: r.actorId },
      source: r.source,
    })),
  ];
  return moves.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
