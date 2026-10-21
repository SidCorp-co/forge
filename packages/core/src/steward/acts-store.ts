// The steward's act log (REQ-48 BC-12): each act a run took through an existing door, what it wrote
// and the door that undoes it, and the one undo door that calls that inverse as the person who asked.

import { verbatim } from '@forge/contracts/said';
import type {
  StewardAct,
  StewardActRecord,
  StewardCite,
  StewardRefusalCode,
} from '@forge/contracts/steward';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type StewardUndo, stewardActs } from '../db/schema-steward-runs.js';
import { refuser } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { callDoor, type DoorAnswer, type DoorMethod } from './door-call.js';
import { isInverseDoor, overrideOf } from './undo-rules.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_ACT_UNKNOWN');

type ActRow = typeof stewardActs.$inferSelect;

export interface ActWrite {
  runId: string;
  projectId: string;
  act: StewardAct;
  door: string;
  did: string;
  wrote: StewardCite | null;
  undo: StewardUndo | null;
  /** What the act asked the project's master, standing as `stewardAsks` until the sweep settles it. */
  masterAsk?: string | null;
}

export async function recordAct(write: ActWrite, exec: Tx = db): Promise<string> {
  const [row] = await exec
    .insert(stewardActs)
    .values({ ...write, masterAsk: write.masterAsk ?? null })
    .returning({ id: stewardActs.id });
  if (!row) throw new Error('steward: the act insert returned no row');
  return row.id;
}

export function actRecordOf(row: ActRow): StewardActRecord {
  return {
    id: row.id,
    runId: row.runId,
    door: row.door,
    did: row.did,
    says: { did: verbatim(row.did) },
    wrote: row.wrote ?? null,
    undo: row.undo ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undoneBy: row.undoneBy,
    at: row.at.toISOString(),
  };
}

/** Every act of the runs named, oldest first, grouped by run. */
export async function actsOfRuns(
  runIds: readonly string[],
): Promise<Map<string, StewardActRecord[]>> {
  const out = new Map<string, StewardActRecord[]>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select()
    .from(stewardActs)
    .where(inArray(stewardActs.runId, [...runIds]))
    .orderBy(asc(stewardActs.at));
  for (const row of rows) out.set(row.runId, [...(out.get(row.runId) ?? []), actRecordOf(row)]);
  return out;
}

/** The record an inverse door wrote, from its answer: a re-proposed suggestion, a reopened item. */
function wroteOf(answer: DoorAnswer): string | null {
  const json = answer.json ?? {};
  const record = (json.suggestion ?? json.feedback ?? null) as {
    id?: unknown;
    key?: unknown;
  } | null;
  if (record && typeof record.key === 'string') return record.key;
  if (record && typeof record.id === 'string') return record.id;
  return null;
}

export type UndoOutcome =
  | {
      ok: true;
      act: StewardActRecord;
      undone: { door: string; status: number; wrote: string | null };
    }
  | { ok: false; answer: DoorAnswer };

/**
 * Undo one act (`POST /api/projects/:id/steward-acts/:actId/undo`): its inverse door is called with
 * the asking person's own credential, so that door decides whether they may. An act with no inverse
 * is refused `STEWARD_ACT_NOT_UNDOABLE`, naming how a person overrides it; one already undone,
 * `STEWARD_ACT_SUPERSEDED`. A refused inverse is answered as its door answered.
 */
export async function undoAct(args: {
  projectId: string;
  actId: string;
  userId: string;
  credential: Record<string, string>;
}): Promise<UndoOutcome> {
  await requireCan(actorFor(args.userId), 'project.write', projectResource(args.projectId));
  const [row] = await db
    .select()
    .from(stewardActs)
    .where(and(eq(stewardActs.id, args.actId), eq(stewardActs.projectId, args.projectId)))
    .limit(1);
  if (!row) {
    throw refuse('STEWARD_ACT_UNKNOWN', `no steward act ${args.actId} in this project`, '/actId');
  }
  if (row.undoneAt) {
    throw refuse(
      'STEWARD_ACT_SUPERSEDED',
      `steward act ${row.id} (${row.door}) was already undone at ${row.undoneAt.toISOString()}`,
      '/actId',
    );
  }
  if (!row.undo) {
    throw refuse(
      'STEWARD_ACT_NOT_UNDOABLE',
      `steward act ${row.id} called ${row.door}, which no door undoes. To override it, ${overrideOf(row.door)}.`,
      '/actId',
    );
  }
  if (!isInverseDoor(row.undo.door)) {
    throw new Error(
      `steward: act ${row.id} names ${row.undo.door} as its undo, which is no inverse door the catalogue admits`,
    );
  }
  const [method, path] = row.undo.door.split(' ') as [DoorMethod, string];
  const answer = await callDoor(
    { method, path, ...(row.undo.body ? { body: row.undo.body } : {}) },
    args.credential,
  );
  if (!answer.ok) return { ok: false, answer };
  const wrote = wroteOf(answer);
  const [updated] = await db
    .update(stewardActs)
    .set({ undoneAt: new Date(), undoneBy: args.userId, undoWrote: wrote })
    .where(and(eq(stewardActs.id, row.id), isNull(stewardActs.undoneAt)))
    .returning();
  return {
    ok: true,
    act: actRecordOf(updated ?? row),
    undone: { door: row.undo.door, status: answer.status, wrote },
  };
}

/** Whether `recordId` is what a person's undo of a steward act wrote: their override, never new work. */
export async function isUndoOverride(projectId: string, recordId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stewardActs.id })
    .from(stewardActs)
    .where(and(eq(stewardActs.projectId, projectId), eq(stewardActs.undoWrote, recordId)))
    .limit(1);
  return row !== undefined;
}
