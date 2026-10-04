/**
 * The one kernel transition: every status write, on every machine, goes through `transition`. It
 * locks the rows, runs the guards the edge names under that lock, writes the status as a
 * compare-and-set under the kernel's transaction-local flag (the only write the status triggers let
 * through), records the move in `kernel_transitions` with the version of the machine that judged
 * it, and writes its outbox event, all in one transaction. Every reaction to a move (the activity
 * feed, a broadcast, a dispatch) is a consumer of that event.
 */

import type { MachineEntity, MachineOf, StateOf } from '@forge/contracts/machines';
import {
  emitsTransition,
  type OutboxActor,
  type TransitionEventEntity,
  transitionEventType,
} from '@forge/contracts/outbox-events';
import {
  edgeBetween,
  entriesOf,
  type MachineEdge,
  notAnEdgeRefusal,
  type StatusMachine,
  staleTransitionRefusal,
} from '@forge/contracts/state-machine';
import { and, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { delegationOf } from '../credentials/pat-scope.js';
import { asKernelStatusWrite, type KernelExecutor } from '../db/kernel-marker.js';
import { type KernelTransitionActorType, kernelTransitions } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { type Refusal, RefusalError } from '../lib/refusal.js';
import { emitEvents } from '../outbox/index.js';
import { type MachineRow, machineTable } from './machine-tables.js';

export type { KernelExecutor };

type Tx = Parameters<Parameters<KernelExecutor['transaction']>[0]>[0];

/**
 * Who moves the rows. A user actor's credential and delegation are recorded with the move: the ones
 * it carries, else the request's own when the request's credential is that user's.
 */
export type KernelActor =
  | {
      type: 'user';
      id?: string | null;
      agency: ActorAgency;
      tokenId?: string | null;
      onBehalfOf?: string | null;
    }
  | { type: Exclude<KernelTransitionActorType, 'user'>; id?: string | null };

function agencyOf(actor: KernelActor): ActorAgency {
  return actor.type === 'user' ? actor.agency : 'agent';
}

function credentialOf(actor: KernelActor): { tokenId: string | null; onBehalfOf: string | null } {
  if (actor.type !== 'user') return { tokenId: null, onBehalfOf: null };
  if (actor.tokenId !== undefined) {
    return { tokenId: actor.tokenId, onBehalfOf: actor.onBehalfOf ?? null };
  }
  const { tokenId, onBehalfOf } = delegationOf(actor.id);
  return { tokenId, onBehalfOf };
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

/**
 * A guard answers its refusal, or null to let the move through. It never throws a refusal. It runs
 * under the row lock and is pure over what it is given: it reads only through `tx`, and a fact from
 * anywhere else (the project document, the actor's permissions, a provider) is read before the move
 * and handed to it, never fetched over a second connection or the network while the lock is held.
 */
export type Guard<E extends MachineEntity> = (input: GuardInput<E>) => Promise<Refusal | null>;

export interface TransitionArgs<E extends MachineEntity, K extends keyof MachineRow<E>> {
  to: StateOf<E>;
  /** Which rows; the engine adds the machine's edge condition to it. */
  where: SQL | undefined;
  /** The statuses the caller moves from. Each must have an edge to `to`; absent, every state with
   *  one does, and a row elsewhere is left as it is. Not with `expect`. */
  from?: StateOf<E> | readonly StateOf<E>[];
  /** The status the caller read: the move is a compare-and-set on it. A row `where` matches that
   *  stands elsewhere is refused `STALE_TRANSITION` with the expected and actual status (409), and a
   *  read status with no edge to `to` is refused `TRANSITION_NOT_AN_EDGE`. Not with `from`. */
  expect?: StateOf<E>;
  /** Take the machine's recovery edge rather than its lifecycle edge. */
  recovery?: boolean;
  /** Further columns written with the status; an `undefined` value leaves its column as it is. */
  set?: { [C in keyof Omit<MachineRow<E>, 'id'>]?: MachineRow<E>[C] | SQL | undefined };
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
  /** The rows the move wrote; empty when no row stood on an edge into `to`, or anything refused. */
  rows: R[];
  refusals: Refusal[];
}

/**
 * The one row a compare-and-set move (`expect`) wrote. Its refusals are thrown in the envelope; no
 * row means `where` matched none, answered by `gone`: by default an invariant, for a caller that
 * read the row in the same transaction.
 */
export function movedRow<R>(
  result: TransitionResult<R>,
  gone: () => Error = () => new Error('transition: the row a compare-and-set moves matched nothing'),
): R {
  const [lead] = result.refusals;
  if (lead) throw new RefusalError(result.refusals, lead.code);
  const [row] = result.rows;
  if (!row) throw gone();
  return row;
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
  if (args.expect !== undefined) {
    if (args.from !== undefined) {
      throw new Error(`transition: ${args.source} names both \`from\` and \`expect\`; a move takes one`);
    }
    return entries.includes(args.expect) ? [args.expect] : [];
  }
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

  const expected = args.expect;
  const shape = machine as unknown as StatusMachine<string, StateOf<E>>;
  if (expected !== undefined && from.length === 0) {
    return { rows: [], refusals: [notAnEdgeRefusal(shape, expected, args.to)] };
  }
  const prior = (await tx
    .select({ id: idColumn, status: statusColumn })
    .from(table as PgTable)
    .where(expected === undefined ? and(args.where, inArray(statusColumn, from as string[])) : args.where)
    .for('update')) as PriorRow<E>[];
  if (prior.length === 0) return { rows: [], refusals: [] };
  if (expected !== undefined) {
    const stale = prior.filter((r) => r.status !== expected);
    if (stale.length > 0) {
      return {
        rows: [],
        refusals: stale.map((r) =>
          staleTransitionRefusal(shape, r.id, expected, r.status, args.to),
        ),
      };
    }
  }

  const refusals: Refusal[] = [];
  for (const row of prior) {
    const edge = edgeBetween<StateOf<E>>(machine, row.status, args.to, recovery);
    if (!edge)
      throw new Error(
        `transition: ${machine.entity} \`${row.status}\` has no edge to \`${args.to}\``,
      );
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
    .where(
      and(
        inArray(
          idColumn,
          prior.map((r) => r.id),
        ),
        inArray(statusColumn, from as string[]),
      ),
    );
  const rows = (await asKernelStatusWrite(tx, () =>
    projection ? write.returning(projection) : write.returning(),
  )) as Array<Pick<MachineRow<E>, K | 'id'> & { id: string }>;

  const left = new Map(prior.map((r) => [r.id, r.status]));
  const credential = credentialOf(args.actor);
  const records = rows.map((row) => ({
    entity: machine.entity,
    entityId: row.id,
    fromStatus: left.get(row.id) ?? null,
    toStatus: args.to,
    machineVersion: machine.version,
    reason: args.reason ?? null,
    actorType: args.actor.type,
    actorAgency: agencyOf(args.actor),
    actorId: args.actor.id ?? null,
    actorTokenId: credential.tokenId,
    actorOnBehalfOf: credential.onBehalfOf,
    source: args.source,
  }));
  if (records.length > 0) await tx.insert(kernelTransitions).values(records);

  await args.afterWrite?.(tx, rows);
  await emitTransitionEvents(tx, machine, records, args.actor);
  return { rows, refusals: [] };
}

function outboxActorOf(actor: KernelActor): OutboxActor {
  if (actor.type === 'user' && actor.id)
    return { type: 'user', id: actor.id, agency: actor.agency };
  if (actor.type === 'runner' && actor.id) return { type: 'device', id: actor.id, agency: 'agent' };
  return { type: 'device', id: '<system>', agency: agencyOf(actor) };
}

/** The project and issue of each moved row, which the event carries and the record does not. */
async function subjectsOf(
  tx: Tx,
  entity: TransitionEventEntity,
  ids: readonly string[],
): Promise<Map<string, { projectId: string; issueId: string | null }>> {
  const { table } = machineTable(entity);
  const columns = table as unknown as Record<string, PgColumn>;
  const idColumn = columns.id as PgColumn;
  const rows = (await tx
    .select({
      id: idColumn,
      projectId: columns.projectId as PgColumn,
      issueId: (entity === 'issue' ? idColumn : columns.issueId) as PgColumn,
    })
    .from(table as PgTable)
    .where(inArray(idColumn, [...ids]))) as Array<{
    id: string;
    projectId: string;
    issueId: string | null;
  }>;
  return new Map(rows.map((r) => [r.id, { projectId: r.projectId, issueId: r.issueId }]));
}

/** One outbox event per move, for the machines and targets a consumer reads
 *  (`@forge/contracts/outbox-events:TRANSITION_EVENTS`), in the move's own transaction. */
async function emitTransitionEvents(
  tx: Tx,
  machine: MachineOf<MachineEntity>,
  records: ReadonlyArray<{
    entityId: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
  }>,
  actor: KernelActor,
): Promise<void> {
  const entity = machine.entity;
  const emitted = records.filter((r) => emitsTransition(entity, r.toStatus));
  if (emitted.length === 0) return;
  const evented = entity as TransitionEventEntity;
  const subjects = await subjectsOf(
    tx,
    evented,
    emitted.map((r) => r.entityId),
  );
  const at = new Date().toISOString();
  const by = outboxActorOf(actor);
  await emitEvents(
    tx,
    emitted.map((r) => {
      const subject = subjects.get(r.entityId);
      if (!subject)
        throw new Error(`transition: moved ${entity} ${r.entityId} has no row to report`);
      return {
        type: transitionEventType(evented),
        payload: {
          entity: evented,
          id: r.entityId,
          projectId: subject.projectId,
          issueId: subject.issueId,
          from: r.fromStatus,
          to: r.toStatus,
          machineVersion: machine.version,
          reason: r.reason,
          actor: by,
          at,
        },
      } as never;
    }),
  );
}
