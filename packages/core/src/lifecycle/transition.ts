/**
 * The one kernel transition: every status write, on every machine, goes through `transition`. It
 * finds the machine's edge for the move, runs the guards that edge names, writes the status as a
 * compare-and-set, and records the move in `kernel_transitions`, all in one transaction. A side
 * effect beyond that (a broadcast, a cascade, a dispatch tick) is the caller's, after it returns.
 */

import type { MachineEntity, MachineOf, StateOf } from '@forge/contracts/machines';
import {
  edgeBetween,
  entriesOf,
  type MachineEdge,
  notAnEdgeRefusal,
  type StatusMachine,
} from '@forge/contracts/state-machine';
import { and, inArray, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { type KernelExecutor, stampKernelTxn } from '../db/kernel-marker.js';
import { type KernelTransitionActorType, kernelTransitions } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { type MachineRow, machineTable } from './machine-tables.js';

export type { KernelExecutor };

type Tx = Parameters<Parameters<KernelExecutor['transaction']>[0]>[0];

export type KernelActor =
  | { type: 'user'; id?: string | null; agency: ActorAgency }
  | { type: Exclude<KernelTransitionActorType, 'user'>; id?: string | null };

function agencyOf(actor: KernelActor): ActorAgency {
  return actor.type === 'user' ? actor.agency : 'agent';
}

/** A row as the guards and hooks see it before the write: its id and the status it is leaving. */
export interface PriorRow<E extends MachineEntity> {
  id: string;
  status: StateOf<E>;
}

export interface GuardInput<E extends MachineEntity> {
  tx: Tx;
  row: PriorRow<E>;
  to: StateOf<E>;
  edge: MachineEdge<StateOf<E>>;
}

/** A guard answers its refusal, or null to let the move through. It never throws a refusal. */
export type Guard<E extends MachineEntity> = (input: GuardInput<E>) => Promise<Refusal | null>;

export interface TransitionArgs<E extends MachineEntity, K extends keyof MachineRow<E>> {
  to: StateOf<E>;
  /** Which rows; the engine adds the machine's edge condition to it. */
  where: SQL | undefined;
  /** The statuses the caller moves from. Each must have an edge to `to`; absent, every state with
   *  one does, and a row elsewhere is left as it is. */
  from?: StateOf<E> | readonly StateOf<E>[];
  /** Take the machine's recovery edge rather than its lifecycle edge. */
  recovery?: boolean;
  /** Further columns written with the status. */
  set?: Partial<Omit<MachineRow<E>, 'id'>>;
  /** Columns handed back; omit for the whole row. The id is always among them. */
  returning?: readonly K[];
  reason?: string | null;
  actor: KernelActor;
  /** The subsystem making the move, as `kernel_transitions.source` records it. */
  source: string;
  /** The implementation of each guard the reached edges name. */
  guards?: Readonly<Record<string, Guard<E>>>;
  /** Runs after the guards pass and before the status is written, in the same transaction. */
  beforeWrite?: (tx: Tx, rows: readonly PriorRow<E>[]) => Promise<void>;
  /** Runs after the status and its record are written, in the same transaction. */
  afterWrite?: (tx: Tx, rows: ReadonlyArray<Pick<MachineRow<E>, K | 'id'>>) => Promise<void>;
}

export interface TransitionResult<R> {
  /** The rows the move wrote; empty when no row stood on an edge into `to`, or a guard refused. */
  rows: R[];
  refusals: Refusal[];
}

export async function transition<
  M extends MachineOf<MachineEntity>,
  K extends keyof MachineRow<M['entity']> = keyof MachineRow<M['entity']>,
>(
  exec: KernelExecutor,
  machine: M,
  args: TransitionArgs<M['entity'], K>,
): Promise<TransitionResult<Pick<MachineRow<M['entity']>, K | 'id'>>> {
  return exec.transaction((tx) =>
    writeTransition(tx, machine as unknown as MachineOf<M['entity']>, args),
  );
}

function startingStates<E extends MachineEntity>(
  machine: MachineOf<E>,
  args: TransitionArgs<E, never>,
): StateOf<E>[] {
  const entries = entriesOf<StateOf<E>>(machine, args.to, args.recovery === true);
  if (args.from === undefined) {
    if (entries.length === 0) {
      throw new Error(`transition: no edge of machine \`${machine.entity}\` enters \`${args.to}\``);
    }
    return entries;
  }
  const declared = (Array.isArray(args.from) ? args.from : [args.from]) as StateOf<E>[];
  const stray = declared.filter((s) => !entries.includes(s));
  if (stray.length > 0) {
    throw new Error(
      `transition: ${machine.entity} ${stray.map((s) => `\`${s}\``).join(', ')} → \`${args.to}\` is not an edge of its machine (${args.source})`,
    );
  }
  return declared;
}

/** The outbox actor as the issues trigger copies it: a runner box records as the device it is. */
async function setActorContext(tx: Tx, actor: KernelActor, reason: string | null): Promise<void> {
  const type = actor.type === 'user' ? 'user' : actor.type === 'runner' ? 'device' : 'system';
  await tx.execute(sql`
    SELECT
      set_config('pipeline.actor_id', ${actor.id ?? ''}, true),
      set_config('pipeline.actor_type', ${type}, true),
      set_config('pipeline.actor_agency', ${agencyOf(actor)}, true),
      set_config('pipeline.reason', ${reason ?? ''}, true)
  `);
}

function projectionOf(
  table: PgTable,
  idKey: string,
  keys: readonly PropertyKey[] | undefined,
): Record<string, PgColumn> | undefined {
  if (!keys) return undefined;
  const columns = table as unknown as Record<string, PgColumn>;
  const projection: Record<string, PgColumn> = {};
  for (const key of new Set([...keys.map(String), idKey])) {
    const column = columns[key];
    if (!column) throw new Error(`transition: returning names \`${key}\`, which is not a column`);
    projection[key] = column;
  }
  return projection;
}

async function writeTransition<E extends MachineEntity, K extends keyof MachineRow<E>>(
  tx: Tx,
  machine: MachineOf<E>,
  args: TransitionArgs<E, K>,
): Promise<TransitionResult<Pick<MachineRow<E>, K | 'id'>>> {
  const recovery = args.recovery === true;
  const from = startingStates(machine, args as TransitionArgs<E, never>);
  const { table, idKey, statusKey } = machineTable(machine.entity as E);
  const columns = table as unknown as Record<string, PgColumn>;
  const idColumn = columns[idKey] as PgColumn;
  const statusColumn = columns[statusKey] as PgColumn;
  const onEdge = and(args.where, inArray(statusColumn, from as string[]));

  await stampKernelTxn(tx);
  await setActorContext(tx, args.actor, args.reason ?? null);

  const prior = (await tx
    .select({ id: idColumn, status: statusColumn })
    .from(table as PgTable)
    .where(onEdge)
    .for('update')) as PriorRow<E>[];
  if (prior.length === 0) return { rows: [], refusals: [] };

  const refusals: Refusal[] = [];
  for (const row of prior) {
    const edge = edgeBetween<StateOf<E>>(machine, row.status, args.to, recovery);
    if (!edge) throw new Error(`transition: ${machine.entity} \`${row.status}\` has no edge to \`${args.to}\``);
    for (const name of edge.guards) {
      const guard = args.guards?.[name];
      if (!guard) {
        throw new Error(
          `transition: ${machine.entity} \`${row.status}\` → \`${args.to}\` names guard \`${name}\`, and ${args.source} supplied no implementation of it`,
        );
      }
      const refused = await guard({ tx, row, to: args.to, edge });
      if (refused) {
        refusals.push(refused);
        break;
      }
    }
  }
  if (refusals.length > 0) return { rows: [], refusals };

  await args.beforeWrite?.(tx, prior);

  const projection = projectionOf(table as PgTable, idKey, args.returning);
  const write = tx
    .update(table as PgTable)
    .set({ ...(args.set ?? {}), [statusKey]: args.to } as Record<string, unknown>)
    .where(and(inArray(idColumn, prior.map((r) => r.id)), inArray(statusColumn, from as string[])));
  const rows = (projection ? await write.returning(projection) : await write.returning()) as Array<
    Pick<MachineRow<E>, K | 'id'> & { id: string }
  >;

  const left = new Map(prior.map((r) => [r.id, r.status]));
  const records = rows.map((row) => ({
    entity: machine.entity,
    entityId: row.id,
    fromStatus: left.get(row.id) ?? null,
    toStatus: args.to,
    reason: args.reason ?? null,
    actorType: args.actor.type,
    actorAgency: agencyOf(args.actor),
    actorId: args.actor.id ?? null,
    source: args.source,
  }));
  if (records.length > 0) await tx.insert(kernelTransitions).values(records);

  await args.afterWrite?.(tx, rows);
  await emitTransitionEvents(tx, records);
  return { rows, refusals: [] };
}

/** Where a move's outbox event is written, in the move's own transaction. Today the issues table's
 *  AFTER UPDATE trigger writes it from the actor context set above; ISS-166 writes every
 *  machine's event here and retires that trigger. */
async function emitTransitionEvents(
  _tx: Tx,
  _records: ReadonlyArray<{ entity: string; entityId: string; toStatus: string }>,
): Promise<void> {}

/** A move a caller asked for that the machine does not draw, refused by name with the moves it does. */
export function notAnEdgeError(machine: StatusMachine, from: string, to: string): RefusalError {
  return new RefusalError([notAnEdgeRefusal(machine, from, to)], 'TRANSITION_NOT_AN_EDGE');
}
