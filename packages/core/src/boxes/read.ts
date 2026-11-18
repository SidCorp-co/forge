// The box record every door answers with (`@forge/contracts/boxes:BoxRecord`), the project's boxes
// and queue, the act feed and the spans. Reads only.

import type { BoxActRecord, BoxHolder, BoxRecord, BoxSpanRecord } from '@forge/contracts/boxes';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { and, asc, desc, eq, gt, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import {
  type BoxActRow,
  type BoxRow,
  type BoxSpanRow,
  boxActs,
  boxes,
  boxSpans,
} from '../db/schema-boxes.js';

type Reader = Pick<Tx, 'select'>;

export async function boxById(id: string, executor: Reader = db): Promise<BoxRow | null> {
  const [row] = await executor.select().from(boxes).where(eq(boxes.id, id)).limit(1);
  return row ?? null;
}

async function namesOf(ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function holderOf(row: BoxRow, name: string | null = null): BoxHolder | null {
  if (row.state === 'person' && row.heldBy) {
    return { kind: 'person', userId: row.heldBy, name };
  }
  if (row.state === 'agent') return { kind: 'agent', runId: row.runId };
  return null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function recordOf(row: BoxRow, name: string | null): BoxRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    projectId: row.projectId,
    issueId: row.issueId,
    criterion: row.criterion,
    mode: row.mode,
    state: row.state,
    holder: holderOf(row, name),
    heldSince: iso(row.heldSince),
    queue: row.state === 'waiting' ? (row.queue ?? null) : null,
    viewport: row.viewport ?? null,
    url: row.url,
    view: row.view ?? null,
    recording: row.recordingState
      ? {
          state: row.recordingState,
          why: row.recordingState === 'recording' ? row.recordingWhy : null,
          startedAt: iso(row.recordingStartedAt),
        }
      : null,
    failure: row.failure,
    detail: row.detail,
    openedBy: row.createdBy,
    createdAt: row.askedAt.toISOString(),
    closedAt: iso(row.closedAt),
    closedWhy: row.closedWhy ?? null,
  };
}

export async function boxRecord(row: BoxRow): Promise<BoxRecord> {
  const names = await namesOf(row.heldBy ? [row.heldBy] : []);
  return recordOf(row, row.heldBy ? (names.get(row.heldBy) ?? null) : null);
}

/** The display name of a person, for a refusal naming who holds a box. */
export async function personName(userId: string): Promise<string | null> {
  return (await namesOf([userId])).get(userId) ?? null;
}

/**
 * The project's boxes: every one still open, and the closed and failed ones of the last day, newest
 * first; the waiting ones are the queue, in their places.
 */
export async function projectBoxes(projectId: string): Promise<BoxRecord[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await db
    .select()
    .from(boxes)
    .where(
      and(
        eq(boxes.projectId, projectId),
        or(
          inArray(boxes.state, ['waiting', 'opening', 'warm', 'agent', 'person']),
          gt(boxes.askedAt, since),
        ),
      ),
    )
    .orderBy(desc(boxes.askedAt))
    .limit(200);
  const names = await namesOf(rows.flatMap((r) => (r.heldBy ? [r.heldBy] : [])));
  return rows.map((r) => recordOf(r, r.heldBy ? (names.get(r.heldBy) ?? null) : null));
}

export function actRecord(row: BoxActRow): BoxActRecord {
  return {
    id: row.id,
    boxId: row.boxId,
    seq: row.seq,
    by: row.by,
    actor: row.actor,
    kind: row.kind,
    command: row.command,
    state: row.state,
    exitCode: row.exitCode,
    stdout: row.stdout,
    stderr: row.stderr,
    durationMs: row.durationMs,
    refusal: row.refusal,
    at: row.createdAt.toISOString(),
  };
}

/** The feed after `after`, oldest first; `by` narrows it to the agent's acts or the person's input. */
export async function boxActsAfter(
  boxId: string,
  after: number,
  by?: 'agent' | 'person',
): Promise<BoxActRecord[]> {
  const rows = await db
    .select()
    .from(boxActs)
    .where(
      and(eq(boxActs.boxId, boxId), gt(boxActs.seq, after), by ? eq(boxActs.by, by) : undefined),
    )
    .orderBy(asc(boxActs.seq))
    .limit(500);
  return rows.map(actRecord);
}

export async function actById(id: string): Promise<BoxActRow | null> {
  const [row] = await db.select().from(boxActs).where(eq(boxActs.id, id)).limit(1);
  return row ?? null;
}

export function spanRecord(row: BoxSpanRow): BoxSpanRecord {
  return {
    id: row.id,
    boxId: row.boxId,
    issueId: row.issueId,
    criterion: row.criterion,
    state: row.state,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
    clipAttachmentId: row.clipAttachmentId,
    stillAttachmentId: row.stillAttachmentId,
    detail: row.detail,
  };
}

export async function boxSpansOf(boxId: string): Promise<BoxSpanRecord[]> {
  const rows = await db
    .select()
    .from(boxSpans)
    .where(eq(boxSpans.boxId, boxId))
    .orderBy(asc(boxSpans.startedAt));
  return rows.map(spanRecord);
}

/**
 * A box nothing has used since `before`: its newest act, span edge, recording start, person's input
 * or start is older (ISS-1335). The sweep's select and its close both read it, so a box used in
 * between is not closed.
 */
export function unusedSince(before: Date): SQL {
  const lastAct = sql`(SELECT max(greatest(a.created_at, a.done_at)) FROM box_acts a WHERE a.box_id = ${boxes.id})`;
  const lastSpan = sql`(SELECT max(greatest(s.started_at, s.ended_at)) FROM box_spans s WHERE s.box_id = ${boxes.id})`;
  return sql`greatest(${boxes.readyAt}, ${boxes.openedAt}, ${boxes.lastInputAt}, ${boxes.recordingStartedAt}, ${lastAct}, ${lastSpan}) < ${before.toISOString()}::timestamptz`;
}

/** The agent's boxes nothing used since `before`: what the sweep closes `idle`. */
export async function idleAgentBoxes(before: Date, executor: Reader = db): Promise<BoxRow[]> {
  return executor
    .select()
    .from(boxes)
    .where(and(eq(boxes.state, 'agent'), unusedSince(before)))
    .limit(200);
}

/** The boxes still holding a recording on their device whose issue ended: what the sweep drops. */
export async function recordingsOfEndedIssues(executor: Reader = db) {
  return executor
    .select({ id: boxes.id, deviceId: boxes.deviceId })
    .from(boxes)
    .innerJoin(issues, eq(issues.id, boxes.issueId))
    .where(
      and(
        isNotNull(boxes.recordingState),
        inArray(boxes.recordingState, ['recording', 'kept']),
        inArray(boxes.state, ['closed', 'failed']),
        inArray(issues.status, [...ISSUE_TERMINAL_STATUSES]),
      ),
    )
    .limit(200);
}
