// The steward's act log (REQ-48 BC-12): each act a run took through an existing door, what it wrote
// and the door that undoes it, and the one undo door. A person authorises an undo, and the steward
// account, which made the act, executes its inverse; the log keeps who asked.

import { verbatim } from '@forge/contracts/said';
import type {
  StewardAct,
  StewardActRecord,
  StewardCite,
  StewardRefusalCode,
} from '@forge/contracts/steward';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { type StewardUndo, stewardActs, stewardRuns } from '../db/schema-steward-runs.js';
import { refuser } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { stewardAccountOf } from './account.js';
import { mintStewardCredential } from './credential.js';
import { bearer, callDoor, type DoorAnswer, type DoorMethod } from './door-call.js';
import { isInverseDoor, overrideOf, personOverrideOf } from './undo-rules.js';

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
    override: row.undo ? null : personOverrideOf(row.door),
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

/**
 * Every act the steward took on one item, across all its runs, newest first: an item page's Activity
 * reads this, not the runs list, so an act on an old run is never cut off by newer runs (REQ-48 BC-12).
 */
export async function actsOfSubject(projectId: string, key: string): Promise<StewardActRecord[]> {
  const rows = await db
    .select({ act: stewardActs })
    .from(stewardActs)
    .innerJoin(stewardRuns, eq(stewardRuns.id, stewardActs.runId))
    .where(and(eq(stewardActs.projectId, projectId), eq(stewardRuns.subjectKey, key)))
    .orderBy(desc(stewardActs.at), desc(stewardActs.id));
  return rows.map((r) => actRecordOf(r.act));
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

/** How long the token an inverse runs under lives: one door call. */
const UNDO_TOKEN_TTL_MS = 2 * 60_000;

/**
 * Call an act's inverse as the steward account, which made the act (the author of the comment it
 * posted, the proposer of what it wrote), under a token for that act's approvals alone, revoked once
 * the call is answered.
 */
async function inverseAsSteward(row: ActRow, request: Parameters<typeof callDoor>[0]) {
  const credential = await mintStewardCredential({
    projectId: row.projectId,
    stewardId: await stewardAccountOf(row.projectId),
    acts: [row.act],
    ttlMs: UNDO_TOKEN_TTL_MS,
    name: `steward undo ${row.id}`,
  });
  try {
    return await callDoor(request, bearer(credential.token));
  } finally {
    await credential.revoke();
  }
}

/**
 * Undo one act (`POST /api/projects/:id/steward-acts/:actId/undo`). The person asking authorises it
 * with `project.write`; the steward account executes the inverse door, and the act records who
 * asked (`undone_by`). An act with no inverse is refused `STEWARD_ACT_NOT_UNDOABLE`, naming how a
 * person overrides it; one already undone, `STEWARD_ACT_SUPERSEDED`. A refused inverse is answered
 * as its door answered.
 */
export async function undoAct(args: {
  projectId: string;
  actId: string;
  userId: string;
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
  const answer = await inverseAsSteward(row, {
    method,
    path,
    ...(row.undo.body ? { body: row.undo.body } : {}),
  });
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
