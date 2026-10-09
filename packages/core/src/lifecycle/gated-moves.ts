/**
 * The kernel's record of gated moves, read (REQ-34 BC-8, BC-9): one item's moves against each gate
 * its machine asks, and a project's moves over a period counted per gate. A gate is a checklist or a
 * move check (`@forge/contracts/move-gates`); each move reads one standing by the contract's rule,
 * so the item's page and the report never disagree about what passed.
 */

import type { ChecklistAnswer } from '@forge/contracts/checklists';
import { MACHINES, type MachineEntity, type MachineOf } from '@forge/contracts/machines';
import {
  birthStanding,
  GATES,
  type Gate,
  type GatedMoveStanding,
  passedMoveStanding,
} from '@forge/contracts/move-gates';
import type { Refusal } from '@forge/contracts/refusal';
import { and, count, desc, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/client.js';
import { kernelRefusedMoves, kernelTransitions } from '../db/schema.js';
import { machineTable } from './machine-tables.js';

/** One move against one gate, passed or refused, as the kernel recorded it. */
export interface GatedMove {
  at: string;
  from: string | null;
  to: string;
  gate: string;
  standing: GatedMoveStanding;
  /** The checklist that judged it, or null for a move check's and a move recorded before. */
  checklist: { id: string; version: number } | null;
  answers: ChecklistAnswer[] | null;
  refusals: Refusal[] | null;
  actor: { type: string; agency: string; id: string | null };
  source: string;
}

type Reader = Pick<Tx, 'select'>;

const gatesOn = (entity: string): Gate[] => GATES.filter((g) => g.gates.machine === entity);

/** A passed move along any of these gates' statuses. */
function onGateEdges(gates: readonly Gate[]): SQL | undefined {
  return or(
    ...gates.flatMap((g) =>
      g.gates.from.map((from) =>
        and(eq(kernelTransitions.fromStatus, from), eq(kernelTransitions.toStatus, g.gates.to)),
      ),
    ),
  );
}

/** Each gate a passed row stands against, with its standing; a gate the edge did not ask is left out. */
function standingsOf(
  gates: readonly Gate[],
  row: { from: string | null; to: string; checklist: string | null; gates: string[] | null },
): Array<{ gate: Gate; standing: GatedMoveStanding }> {
  return gates.flatMap((gate) => {
    if (gate.gates.to !== row.to || !gate.gates.from.includes(row.from ?? '')) return [];
    const standing = passedMoveStanding(gate, row);
    return standing ? [{ gate, standing }] : [];
  });
}

/**
 * An item's moves against each gate its machine asks, newest first: each passed move with the
 * checklist and answers it was judged by, or `no_checklist` where it was recorded before the gate
 * (never counted as passed), and each refused one naming its gate.
 */
export async function gatedMovesOf<E extends MachineEntity>(
  exec: Reader,
  machine: MachineOf<E>,
  entityId: string,
): Promise<GatedMove[]> {
  const gates = gatesOn(machine.entity);
  if (gates.length === 0) return [];
  const passed = await exec
    .select()
    .from(kernelTransitions)
    .where(
      and(
        eq(kernelTransitions.entity, machine.entity),
        eq(kernelTransitions.entityId, entityId),
        onGateEdges(gates),
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
    ...passed.flatMap((r) =>
      standingsOf(gates, {
        from: r.fromStatus,
        to: r.toStatus,
        checklist: r.checklist,
        gates: r.gates,
      }).map(({ gate, standing }) => ({
        at: r.createdAt.toISOString(),
        from: r.fromStatus,
        to: r.toStatus,
        gate: gate.id,
        standing,
        checklist:
          r.checklist === gate.id && r.checklistVersion !== null
            ? { id: r.checklist, version: r.checklistVersion }
            : null,
        answers: r.checklist === gate.id ? (r.checklistAnswers ?? null) : null,
        refusals: null,
        actor: { type: r.actorType, agency: r.actorAgency, id: r.actorId },
        source: r.source,
      })),
    ),
    ...refused.map((r) => {
      const gate = gates.find((g) => g.id === r.gate);
      return {
        at: r.createdAt.toISOString(),
        from: r.fromStatus,
        to: r.toStatus,
        gate: r.gate,
        standing: 'refused' as const,
        checklist: gate?.kind === 'checklist' ? { id: r.gate, version: r.gateVersion } : null,
        answers: null,
        refusals: r.refusals,
        actor: { type: r.actorType, agency: r.actorAgency, id: r.actorId },
        source: r.source,
      };
    }),
  ];
  return moves.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** One gate's moves over a period, by standing. */
export interface GateCount {
  gate: string;
  title: string;
  passed: number;
  refused: number;
  exception: number;
  noChecklist: number;
}

const BLANK = { passed: 0, refused: 0, exception: 0, noChecklist: 0 } as const;

const STANDING_KEY: Record<GatedMoveStanding, keyof typeof BLANK> = {
  passed: 'passed',
  refused: 'refused',
  exception: 'exception',
  no_checklist: 'noChecklist',
};

/** The columns a gated machine's table is scoped and dated by; a table without them is refused. */
function scopeOf(entity: MachineEntity) {
  const { table, statusKey } = machineTable(entity);
  const columns = table as unknown as Record<string, PgColumn | undefined>;
  const { id, projectId, createdAt } = columns;
  const status = columns[statusKey];
  if (!id || !projectId || !createdAt || !status) {
    throw new Error(
      `gated moves: machine \`${entity}\` has a gate, and its table has no project_id, created_at or status to count its moves by`,
    );
  }
  return { table: table as PgTable, id, projectId, createdAt, status };
}

/**
 * When the gate first judged a move on this deployment, passed or refused; null where it never has.
 * A birth at its status before then was never asked the gate.
 */
async function gateSince(exec: Pick<Tx, 'execute'>, gate: Gate): Promise<Date | null> {
  const rows = (await exec.execute(sql`
    SELECT least(
      (SELECT min(created_at) FROM kernel_transitions
        WHERE entity = ${gate.gates.machine}
          AND (checklist = ${gate.id} OR ${gate.id} = ANY(gates))),
      (SELECT min(created_at) FROM kernel_refused_moves WHERE gate = ${gate.id})
    ) AS since
  `)) as unknown as Array<{ since: Date | string | null }>;
  const since = rows[0]?.since ?? null;
  return since === null ? null : new Date(since);
}

/** The period a count reads: from its start, up to and not including its end. */
export interface GatedPeriod {
  from: Date;
  until: Date;
}

/**
 * A project's gated moves over a period, per gate (REQ-34 BC-8): passed, refused, sent through by
 * exception (born at the gate's status after the gate first judged a move), and recorded before the
 * gate (`no_checklist`, never counted as passed, BC-9). Every registered gate has a row, and so does
 * a gate no longer registered that still holds refusals in the period.
 */
export async function gatedMoveCounts(
  projectId: string,
  period: GatedPeriod,
  exec: Pick<Tx, 'select' | 'execute'> = db,
): Promise<GateCount[]> {
  const counts = new Map<string, GateCount>(
    GATES.map((g) => [g.id, { gate: g.id, title: g.title, ...BLANK }]),
  );
  const add = (gate: string, standing: GatedMoveStanding, n = 1) => {
    const row = counts.get(gate) ?? { gate, title: gate, ...BLANK };
    row[STANDING_KEY[standing]] += n;
    counts.set(gate, row);
  };
  const entities = [...new Set(GATES.map((g) => g.gates.machine))] as MachineEntity[];
  for (const entity of entities) {
    const gates = gatesOn(entity);
    const scope = scopeOf(entity);
    const passed = await exec
      .select({
        from: kernelTransitions.fromStatus,
        to: kernelTransitions.toStatus,
        checklist: kernelTransitions.checklist,
        gates: kernelTransitions.gates,
      })
      .from(kernelTransitions)
      .innerJoin(scope.table, eq(scope.id, kernelTransitions.entityId))
      .where(
        and(
          eq(kernelTransitions.entity, entity),
          eq(scope.projectId, projectId),
          gte(kernelTransitions.createdAt, period.from),
          lt(kernelTransitions.createdAt, period.until),
          onGateEdges(gates),
        ),
      );
    for (const row of passed) {
      for (const { gate, standing } of standingsOf(gates, row)) add(gate.id, standing);
    }
    const refused = await exec
      .select({ gate: kernelRefusedMoves.gate, n: count() })
      .from(kernelRefusedMoves)
      .innerJoin(scope.table, eq(scope.id, kernelRefusedMoves.entityId))
      .where(
        and(
          eq(kernelRefusedMoves.entity, entity),
          eq(scope.projectId, projectId),
          gte(kernelRefusedMoves.createdAt, period.from),
          lt(kernelRefusedMoves.createdAt, period.until),
        ),
      )
      .groupBy(kernelRefusedMoves.gate);
    for (const row of refused) add(row.gate, 'refused', row.n);
    const initial: readonly string[] = MACHINES[entity].initial;
    const bornGated = gates.filter((g) => initial.includes(g.gates.to));
    if (bornGated.length === 0) continue;
    const births = await exec
      .select({
        bornAt: scope.createdAt,
        status: scope.status,
        // the status an item left first is the one it was born at; one never moved stands there
        first: sql<string | null>`(SELECT k.from_status FROM kernel_transitions k
          WHERE k.entity = ${entity} AND k.entity_id = ${scope.table}.id
          ORDER BY k.created_at, k.id LIMIT 1)`,
      })
      .from(scope.table)
      .where(
        and(
          eq(scope.projectId, projectId),
          gte(scope.createdAt, period.from),
          lt(scope.createdAt, period.until),
        ),
      );
    for (const gate of bornGated) {
      const born = births.filter((b) => (b.first ?? b.status) === gate.gates.to);
      if (born.length === 0) continue;
      const gateFrom = await gateSince(exec, gate);
      for (const b of born)
        add(gate.id, birthStanding(new Date(b.bornAt as Date | string), gateFrom));
    }
  }
  return [...counts.values()];
}
