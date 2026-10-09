// A POC room (REQ-44; contracts `poc-room.ts`): an idea preview members join and chat in. Its branch,
// agent and preview are the idea's (`./subjects.ts`): a message is one ask, delivered straight to the
// sketch run with nothing run in between (BC-3). When the run's turn ends its session's bridge stamps
// every ask waiting on it shown and reads the commit that showed it (BC-4, BC-6, `./room-turns.ts`).
// Settling is `./room-settle.ts`.

import { randomUUID } from 'node:crypto';
import {
  type OpenRoomRequest,
  ROOM_LIMITS,
  ROOM_MACHINE,
  type Room,
  type RoomRefusalCode,
} from '@forge/contracts/poc-room';
import { PREVIEW_LIMITS } from '@forge/contracts/preview';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema-auth.js';
import {
  type PocRoomRow,
  pocRoomItems,
  pocRoomMembers,
  pocRooms,
  pocRoomTurns,
} from '../db/schema-poc-rooms.js';
import type { PreviewRow } from '../db/schema-previews.js';
import { issueDisplayIds } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { requireHeld } from '../permissions/index.js';
import { type PreviewActor, rowOf, siteOrRefuse, userActor, view } from './access.js';
import { previewOrigin } from './domain.js';
import { OPEN_STATES } from './rules.js';
import { closeAbandoned, reopenForViewer } from './service.js';
import { deliverToSketch, openIdeaPreview } from './subjects.js';

export const refuseRoom = refuser<RoomRefusalCode>('ROOM_FORBIDDEN');

const SOURCE = 'poc-rooms';

/** One room's work at a time: two snapshots of one preview would answer each other's waiter. */
const chains = new Map<string, Promise<void>>();

export function inRoomOrder(roomId: string, work: () => Promise<void>): Promise<void> {
  const prior = chains.get(roomId) ?? Promise.resolve();
  const next = prior.then(work, work).catch((err: unknown) => {
    logger.error({ err, roomId }, 'poc-rooms: a room step failed');
  });
  chains.set(roomId, next);
  void next.finally(() => {
    if (chains.get(roomId) === next) chains.delete(roomId);
  });
  return next;
}

/** The caller's access to the room's project: a stranger is told the room does not exist. */
async function roomAccess(
  room: PocRoomRow,
  actor: PreviewActor,
  permission: 'project.read' | 'project.write',
  act: string,
) {
  const access = await loadProjectAccess(
    room.projectId,
    actor.userId,
    `no POC room ${room.id}`,
  ).catch(() => {
    throw refuseRoom('ROOM_NOT_FOUND', `no POC room ${room.id}`);
  });
  try {
    requireHeld(access, 'project.read', act);
  } catch {
    throw refuseRoom('ROOM_NOT_FOUND', `no POC room ${room.id}`);
  }
  try {
    requireHeld(access, permission, act);
  } catch {
    throw refuseRoom(
      'ROOM_FORBIDDEN',
      `${permission} on this project is needed to ${act}; a project member who holds it can`,
    );
  }
  return access;
}

export async function roomRow(roomId: string): Promise<PocRoomRow> {
  const [row] = await db.select().from(pocRooms).where(eq(pocRooms.id, roomId)).limit(1);
  if (!row) throw refuseRoom('ROOM_NOT_FOUND', `no POC room ${roomId}`);
  return row;
}

export async function roomOfSession(sessionId: string): Promise<PocRoomRow | null> {
  const [row] = await db.select().from(pocRooms).where(eq(pocRooms.sessionId, sessionId)).limit(1);
  return row ?? null;
}

function openOrRefuse(room: PocRoomRow, act: string): void {
  if (room.state !== 'open') {
    throw refuseRoom(
      'ROOM_CLOSED',
      `POC room ${room.id} is ${room.state}: only an open room can ${act}`,
    );
  }
}

async function addMember(roomId: string, userId: string): Promise<void> {
  await db.insert(pocRoomMembers).values({ roomId, userId }).onConflictDoNothing();
}

async function nextSeq(roomId: string): Promise<number> {
  const [r] = (await db.execute(
    sql`SELECT coalesce(max(seq), 0)::int + 1 AS n FROM poc_room_turns WHERE room_id = ${roomId}::uuid`,
  )) as unknown as { n: number }[];
  return r?.n ?? 1;
}

/** A turn of the room: an ask a person made, or the agent's own trim before a settle. */
export async function insertTurn(
  roomId: string,
  kind: 'ask' | 'trim',
  askedBy: string | null,
  ask: string,
) {
  const count = await db.$count(pocRoomTurns, eq(pocRoomTurns.roomId, roomId));
  if (count >= ROOM_LIMITS.turns) {
    throw refuseRoom(
      'ROOM_CLOSED',
      `POC room ${roomId} holds ${ROOM_LIMITS.turns} turns, as many as a room keeps: settle what it shows, or open another room`,
    );
  }
  const [turn] = await db
    .insert(pocRoomTurns)
    .values({ roomId, seq: await nextSeq(roomId), kind, askedBy, ask })
    .returning();
  if (!turn) throw new Error('poc-rooms: the turn insert returned no row');
  return turn;
}

/** Open a room about a requirement or a feedback item, with the first ask (BC-1). Needs project.write. */
export async function openRoom(
  projectId: string,
  request: OpenRoomRequest,
  actor: PreviewActor,
): Promise<Room> {
  siteOrRefuse();
  const id = randomUUID();
  const { row, plan, item } = await openIdeaPreview(
    projectId,
    { kind: 'idea', about: request.about, brief: request.brief },
    actor,
    { id },
  );
  if (row.subject?.kind !== 'idea' || row.sessionId === null) {
    throw new Error('poc-rooms: the idea preview was opened without its sketch run');
  }
  await db.insert(pocRooms).values({
    id,
    projectId,
    previewId: row.id,
    sessionId: row.sessionId,
    aboutKind: item.kind,
    aboutKey: item.key,
    branch: row.subject.branch,
    data: plan.data,
    createdBy: actor.userId,
  });
  await addMember(id, actor.userId);
  await insertTurn(id, 'ask', actor.userId, request.brief);
  return readRoom(id, actor);
}

/**
 * Join a room (BC-5): a project member who reads it becomes one of its members. A sleeping preview is
 * woken by a member who may write (BC-9); the branch it serves was kept while it slept.
 */
export async function joinRoom(roomId: string, actor: PreviewActor): Promise<Room> {
  const room = await roomRow(roomId);
  const access = await roomAccess(room, actor, 'project.read', 'join the POC room');
  await addMember(room.id, actor.userId);
  if (room.state === 'open') await wake(room, actor.userId);
  void access;
  return readRoom(room.id, actor);
}

/** An idle-closed preview starts again on the same branch, for a member who may write. */
async function wake(room: PocRoomRow, userId: string): Promise<boolean> {
  const preview = await rowOf(room.previewId);
  if (preview.state !== 'idle_closed') return false;
  return reopenForViewer(preview, userId);
}

/**
 * Ask the room agent for a change (BC-3): the ask is kept as a turn and sent straight to the sketch
 * run as its next turn or an inject; nothing is built, checked or reviewed before the preview shows
 * it. A sleeping preview is woken first.
 */
export async function askRoom(roomId: string, actor: PreviewActor, text: string): Promise<Room> {
  const room = await roomRow(roomId);
  await roomAccess(room, actor, 'project.write', 'ask the room agent for a change');
  openOrRefuse(room, 'take an ask');
  await addMember(room.id, actor.userId);
  await wake(room, actor.userId);
  const preview = await rowOf(room.previewId);
  // a failed or closed preview never shows a turn, so an ask kept there could never be settled
  if (preview.state !== 'live' && preview.state !== 'starting') {
    throw refuseRoom(
      'ROOM_ASLEEP',
      `the room's preview is ${preview.state}${preview.reason ? ` (${preview.reason})` : ''} and did not wake: nothing was asked; open a new room`,
    );
  }
  await insertTurn(room.id, 'ask', actor.userId, text);
  await deliverToSketch(preview, null, actor, text);
  return readRoom(room.id, actor);
}

/** Settle what a turn showed (BC-6): the item is tied to the turn and the commit that showed it. */
export async function settleItem(
  roomId: string,
  actor: PreviewActor,
  request: { turnId: string; text?: string | undefined },
): Promise<Room> {
  const room = await roomRow(roomId);
  await roomAccess(room, actor, 'project.write', 'settle an item');
  openOrRefuse(room, 'settle an item');
  const [turn] = await db
    .select()
    .from(pocRoomTurns)
    .where(and(eq(pocRoomTurns.id, request.turnId), eq(pocRoomTurns.roomId, room.id)))
    .limit(1);
  if (!turn) throw refuseRoom('ROOM_NOT_FOUND', `no turn ${request.turnId} in POC room ${room.id}`);
  if (turn.kind !== 'ask' || turn.shownAt === null || turn.commitSha === null) {
    throw refuseRoom(
      'ROOM_TURN_NOT_SHOWN',
      `turn ${turn.seq} of POC room ${room.id} ${turn.shownAt === null ? 'has not shown in the preview yet' : 'showed no commit: the box read no change for it'}: an item is settled from a turn the preview showed, tied to the commit that showed it`,
    );
  }
  await db.insert(pocRoomItems).values({
    roomId: room.id,
    turnId: turn.id,
    commitSha: turn.commitSha,
    text: (request.text ?? turn.ask).slice(0, ROOM_LIMITS.item),
    settledBy: actor.userId,
  });
  return readRoom(room.id, actor);
}

export async function unsettleItem(
  roomId: string,
  itemId: string,
  actor: PreviewActor,
): Promise<Room> {
  const room = await roomRow(roomId);
  await roomAccess(room, actor, 'project.write', 'unsettle an item');
  openOrRefuse(room, 'unsettle an item');
  const gone = await db
    .delete(pocRoomItems)
    .where(and(eq(pocRoomItems.id, itemId), eq(pocRoomItems.roomId, room.id)))
    .returning({ id: pocRoomItems.id });
  if (gone.length === 0)
    throw refuseRoom('ROOM_NOT_FOUND', `no item ${itemId} in POC room ${room.id}`);
  return readRoom(room.id, actor);
}

/**
 * Abandon a room (BC-10): the room closes abandoned, the preview with it, and the box removes the
 * checkout and deletes the branch and its kept ref. The turns stay: the chat remains readable.
 */
export async function abandonRoom(
  roomId: string,
  actor: PreviewActor,
  reason: string | undefined,
): Promise<Room> {
  const room = await roomRow(roomId);
  await roomAccess(room, actor, 'project.write', 'abandon the POC room');
  if (room.state === 'settled' || room.state === 'abandoned') {
    throw refuseRoom('ROOM_CLOSED', `POC room ${room.id} is ${room.state} already`);
  }
  const preview = await rowOf(room.previewId);
  const asked = room.state === 'settling' ? (room.settle?.mergeAskedAt ?? null) : null;
  // once the box is asked to merge, only its report decides the room: an abandon then would delete
  // the branch under a merge that may still land. A preview no longer open can report nothing.
  if (asked !== null && OPEN_STATES.includes(preview.state)) {
    throw refuseRoom(
      'ROOM_MERGE_PENDING',
      `POC room ${room.id} asked its box to merge into ${room.settle?.into} at ${asked}: it settles or reopens on the box's report`,
    );
  }
  const unreported =
    asked === null ? '' : `; the merge into ${room.settle?.into} asked at ${asked} was never reported`;
  const why = `${reason ?? 'abandoned by a person'}${unreported}`.slice(0, PREVIEW_LIMITS.detail);
  movedRow(
    await transition(db, ROOM_MACHINE, {
      to: 'abandoned',
      expect: room.state,
      where: eq(pocRooms.id, room.id),
      set: {
        detail: why,
        closedAt: new Date(),
        ...(room.settle ? { settle: { ...room.settle, snapshot: null } } : {}),
      },
      reason: why,
      actor: userActor(actor),
      source: SOURCE,
    }),
  );
  await closeAbandoned(
    preview,
    actor,
    `the POC room was abandoned: ${why}`,
    true,
  );
  return readRoom(room.id, actor);
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.displayName?.trim() || r.email]));
}

/** The room as every member reads it (project.read). */
export async function readRoom(roomId: string, actor: PreviewActor): Promise<Room> {
  const room = await roomRow(roomId);
  const access = await roomAccess(room, actor, 'project.read', 'read the POC room');
  let canWrite = true;
  try {
    requireHeld(access, 'project.write', 'write');
  } catch {
    canWrite = false;
  }
  return roomView(room, canWrite);
}

export async function roomView(room: PocRoomRow, canWrite: boolean): Promise<Room> {
  const preview: PreviewRow = await rowOf(room.previewId);
  const [members, turns, items, item] = await Promise.all([
    db
      .select()
      .from(pocRoomMembers)
      .where(eq(pocRoomMembers.roomId, room.id))
      .orderBy(asc(pocRoomMembers.joinedAt)),
    db
      .select()
      .from(pocRoomTurns)
      .where(eq(pocRoomTurns.roomId, room.id))
      .orderBy(asc(pocRoomTurns.seq)),
    db
      .select()
      .from(pocRoomItems)
      .where(eq(pocRoomItems.roomId, room.id))
      .orderBy(asc(pocRoomItems.settledAt)),
    titleOf(room),
  ]);
  const names = await namesOf([
    room.createdBy,
    ...members.map((m) => m.userId),
    ...turns.flatMap((t) => (t.askedBy ? [t.askedBy] : [])),
    ...items.map((i) => i.settledBy),
    ...(room.settle ? [room.settle.askedBy] : []),
  ]);
  const person = (userId: string) => ({ userId, name: names.get(userId) ?? 'A former member' });
  const settle = room.settle;
  return {
    id: room.id,
    projectId: room.projectId,
    about: { kind: room.aboutKind, key: room.aboutKey, title: item },
    branch: room.branch,
    state: room.state,
    detail: room.detail,
    data: room.data,
    createdBy: person(room.createdBy),
    createdAt: room.createdAt.toISOString(),
    preview: view(preview),
    members: members.map((m) => ({ ...person(m.userId), joinedAt: m.joinedAt.toISOString() })),
    turns: turns.map((t) => ({
      id: t.id,
      seq: t.seq,
      by: t.askedBy ? person(t.askedBy) : null,
      ask: t.ask,
      askedAt: t.askedAt.toISOString(),
      reply: t.reply,
      shownAt: iso(t.shownAt),
      shownAfterMs:
        t.shownAt === null ? null : Math.max(0, t.shownAt.getTime() - t.askedAt.getTime()),
      commit: t.commitSha,
      files: t.files ?? null,
      kind: t.kind,
    })),
    items: items.map((i) => ({
      id: i.id,
      turnId: i.turnId,
      commit: i.commitSha,
      text: i.text,
      settledBy: person(i.settledBy),
      settledAt: i.settledAt.toISOString(),
    })),
    settle: settle
      ? {
          into: settle.into,
          askedBy: person(settle.askedBy),
          askedAt: settle.askedAt,
          mergeSha: settle.mergeSha,
          requirement: settle.requirement,
          revision: settle.revision,
          issue: settle.issueId
            ? { id: settle.issueId, displayId: await displayIdOf(settle.issueId) }
            : null,
          refusals: settle.refusals,
        }
      : null,
    canWrite,
  };
}

async function titleOf(room: PocRoomRow): Promise<string> {
  const rows = (await db.execute(
    room.aboutKind === 'requirement'
      ? sql`SELECT title FROM requirements WHERE project_id = ${room.projectId}::uuid AND req_seq = ${Number(room.aboutKey.slice(4))}`
      : sql`SELECT title FROM feedback WHERE project_id = ${room.projectId}::uuid AND fb_seq = ${Number(room.aboutKey.slice(3))}`,
  )) as unknown as { title: string }[];
  return rows[0]?.title ?? room.aboutKey;
}

async function displayIdOf(issueId: string): Promise<string | null> {
  return (await issueDisplayIds([issueId])).get(issueId) ?? null;
}

/** The project's rooms, newest first, as a member lists them. */
export async function listRooms(projectId: string, actor: PreviewActor) {
  await loadProjectAccess(projectId, actor.userId).catch(() => {
    throw refuseRoom('ROOM_NOT_FOUND', `no project ${projectId}`);
  });
  const rows = await db
    .select({
      id: pocRooms.id,
      about: pocRooms.aboutKey,
      state: pocRooms.state,
      createdAt: pocRooms.createdAt,
      members: sql<number>`(SELECT count(*)::int FROM poc_room_members m WHERE m.room_id = ${pocRooms.id})`,
    })
    .from(pocRooms)
    .where(eq(pocRooms.projectId, projectId))
    .orderBy(desc(pocRooms.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Where the room's preview is served: what the agent's brief and a settle name. */
export function roomPreviewUrl(preview: PreviewRow): string {
  return `${previewOrigin(siteOrRefuse(), preview.slug)}/`;
}
