// A release reaching production, handed to the agent of each room that opted in (ISS-854): the
// release's user-facing notes, never its issue titles, for the agent to write one short post in its
// persona's language and voice. Core composes no room text. A release is kept pending on the room
// (`release_pending`, its output empty until it is settled) and handed on with every other pending one as one note (`release_told`), at
// most once an hour, as the channel's one top-level post an hour allows. A release with no
// user-facing note is recorded with why and handed nowhere; a room that did not opt in is not read.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { deliverWaiting } from './dispatch.js';
import { supportConfigOf } from './grants.js';
import { RELEASE_THREAD_PREFIX } from './rules.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';

/** How often a room is handed release notes, at most: the channel's one top-level post an hour. */
const TELL_EVERY_MS = 60 * 60_000;

interface ReleaseNote {
  title: string;
  userFacing: string;
}

/** The user-facing notes the release carries; a `Skip` note or an empty one is none. */
async function userFacingNotes(issueIds: readonly string[]): Promise<ReleaseNote[]> {
  if (issueIds.length === 0) return [];
  const carried = await db
    .select({ notes: issues.releaseNotes })
    .from(issues)
    .where(inArray(issues.id, [...issueIds]));
  const out: ReleaseNote[] = [];
  for (const { notes } of carried) {
    const said = notes?.userFacing?.trim();
    if (!notes || notes.section === 'Skip' || !said || said === '-') continue;
    out.push({ title: notes.title?.trim() ?? '', userFacing: said });
  }
  return out;
}

/** The rooms of a project whose binding opted in to releases. */
async function announcingRooms(projectId: string): Promise<RoomRow[]> {
  const out: RoomRow[] = [];
  for (const room of await roomsOfProject(projectId)) {
    if (room.kind === 'operations') continue;
    if ((await supportConfigOf(room))?.announce?.releases === true) out.push(room);
  }
  return out;
}

/** A release run's ship stamped: kept pending on each room that opted in, or recorded as told to nobody. */
export async function noteReleaseShipped(p: OutboxEventPayload<'release.shipped'>): Promise<void> {
  const rooms = await announcingRooms(p.projectId);
  if (rooms.length === 0) return;
  const notes = await userFacingNotes(p.issueIds);
  for (const room of rooms) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: null,
      thread: `${RELEASE_THREAD_PREFIX}${p.runId}`,
      kind: 'operation',
      actorKind: 'core',
      tool: 'release_pending',
      input: { version: p.version, notes },
      // a release with nothing a user would read is settled at once: nothing is handed on for it
      output: notes.length ? null : { told: false, why: 'the release carries no user-facing note' },
    });
  }
  await deliverReleaseNotes(p.projectId);
}

/** Hand each room its pending releases as one note, where none was handed it in the last hour. */
export async function deliverReleaseNotes(projectId?: string): Promise<void> {
  const pending = await db
    .select()
    .from(supportActions)
    .where(
      and(
        eq(supportActions.tool, 'release_pending'),
        isNull(supportActions.output),
        ...(projectId ? [eq(supportActions.projectId, projectId)] : []),
      ),
    )
    .orderBy(supportActions.createdAt);
  const byRoom = new Map<string, typeof pending>();
  for (const row of pending) byRoom.set(row.roomId, [...(byRoom.get(row.roomId) ?? []), row]);
  for (const [roomId, rows] of byRoom) {
    await tellRoom(roomId, rows).catch((err) =>
      logger.error({ err, roomId }, 'support: release notes were not handed to the room'),
    );
  }
}

async function tellRoom(
  roomId: string,
  rows: (typeof supportActions.$inferSelect)[],
): Promise<void> {
  const [recent] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, roomId),
        eq(supportActions.tool, 'release_told'),
        gte(supportActions.createdAt, new Date(Date.now() - TELL_EVERY_MS)),
      ),
    )
    .limit(1);
  if (recent) return;
  const first = rows[0];
  if (!first) return;
  const releases = rows.map((r) => r.input as { version: string; notes: ReleaseNote[] });
  const lines = releases.flatMap((r) =>
    r.notes.map((n) => `- ${r.version}${n.title ? ` — ${n.title}` : ''}: ${n.userFacing}`),
  );
  const note = [
    `${releases.length === 1 ? 'A release' : `${releases.length} releases`} reached production (${releases.map((r) => r.version).join(', ')}). What changed for users, from the release notes:`,
    ...lines,
    "Tell the channel in one short post, in your persona's language and voice, with support.announce or where the channel's rules put such news: what changed for them, never issue keys, versions or process unless your persona asks for them. Post nothing if none of it matters to this channel.",
  ].join('\n');
  const now = new Date();
  // the note and its settling are one write: a room is never handed the same release twice
  await db.transaction(async (tx) => {
    await insertAction(
      {
        roomId,
        projectId: first.projectId,
        conversationId: null,
        thread: first.thread,
        kind: 'message_in',
        actorKind: 'core',
        input: { note },
        externalId: `release-told:${first.id}`,
      },
      tx,
    );
    await insertAction(
      {
        roomId,
        projectId: first.projectId,
        conversationId: null,
        thread: first.thread,
        kind: 'operation',
        actorKind: 'core',
        tool: 'release_told',
        input: { versions: releases.map((r) => r.version) },
      },
      tx,
    );
    await tx
      .update(supportActions)
      .set({ output: { told: true, at: now.toISOString() } })
      .where(
        inArray(
          supportActions.id,
          rows.map((r) => r.id),
        ),
      );
  });
  await deliverWaiting(roomId);
}

export function registerSupportReleaseNotes(): void {
  consume('release.shipped', { name: 'support-release-notes', handle: noteReleaseShipped });
}
