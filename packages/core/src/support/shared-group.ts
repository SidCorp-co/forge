// A group two projects' bindings hold on one bot (ISS-933): every binding naming it is handed its
// messages, and a mention of the bot is a mention of all of them. So a project is addressed there by
// its own name (ISS-1220, owner 2026-11-12: #sid-email is sidcorp-mail's, and sid-desk acts there only
// when it is named): `@sid-desk` is sid-desk's, kept as context by every other project of the group,
// and a project answering only mentions answers only its name, never the bot the group shares.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { forgeReads } from '../integrations/index.js';
import { mentionsIn } from './channel.js';
import type { Addressed } from './inbound.js';
import { roomIsBound } from './rooms.js';
import { type RoomRow, roomsOnRid } from './store.js';

/** The projects holding the group beside a room's own, by slug, lower case. */
export interface GroupSharers {
  self: string;
  others: string[];
}

/** Who else holds the room's group through an active binding; null where its project holds it alone. */
export async function groupSharers(room: RoomRow): Promise<GroupSharers | null> {
  const others = new Set<string>();
  for (const r of await roomsOnRid(room.rid)) {
    if (r.projectId === room.projectId || others.has(r.projectId)) continue;
    if (await roomIsBound(r)) others.add(r.projectId);
  }
  if (others.size === 0) return null;
  const projects = await forgeReads().projectsByIds([room.projectId, ...others]);
  const slugOf = (id: string) => projects.find((p) => p.id === id)?.slug.toLowerCase() ?? null;
  const self = slugOf(room.projectId);
  if (!self) return null;
  return { self, others: [...others].flatMap((id) => slugOf(id) ?? []) };
}

/** Whom a message is for in the room, and whether it names another project of a shared group. */
export interface GroupAddress {
  addressed: Addressed;
  /** Names another project of the group and not this one: that project's, context here. */
  forAnother: boolean;
  /** Names this room's project by its name in a shared group: this project's, whoever holds the thread. */
  namesThis: boolean;
}

/**
 * Whom `text` addresses in a room whose group `sharers` share, `bare` being what the server's
 * mentions say of the bot. Naming the room's project is addressing it; naming another project of the
 * group, and not this one, is for that one. A bare mention of the shared bot is for the projects
 * hearing every message, so a mention-only project reads it as for others.
 */
export function addressedInGroup(
  text: string,
  bare: Addressed,
  sharers: GroupSharers | null,
  mentionsOnly: boolean,
): GroupAddress {
  const none = { forAnother: false, namesThis: false };
  if (!sharers) return { addressed: bare, ...none };
  const named = new Set(mentionsIn(text).map((n) => n.toLowerCase()));
  if (named.has(sharers.self)) return { addressed: 'you', forAnother: false, namesThis: true };
  if (sharers.others.some((s) => named.has(s))) {
    return { addressed: 'others', forAnother: true, namesThis: false };
  }
  if (mentionsOnly && bare === 'you') return { addressed: 'others', ...none };
  return { addressed: bare, ...none };
}

/**
 * Whether another binding naming the room's group holds `thread` (ISS-1243): its session posted the
 * thread's last reply. That thread is the holder's: this room keeps its messages as context, and
 * posts no failure line there, unless a message names this room's project. A thread no session
 * replied in is held by none. Before this, a mention-only binding that had once replied in a thread
 * was handed every later message of it, though the other binding had taken it over (sid-email).
 */
export async function threadHeldByAnother(room: RoomRow, thread: string): Promise<boolean> {
  const others: RoomRow[] = [];
  for (const r of await roomsOnRid(room.rid)) {
    if (r.bindingId !== room.bindingId && (await roomIsBound(r))) others.push(r);
  }
  if (others.length === 0) return false;
  const holder = await lastPosterInThread([room.id, ...others.map((r) => r.id)], thread);
  return holder !== null && holder !== room.id;
}

/** Which of these rooms' sessions replied last in `thread`, by room id; null where none did. */
async function lastPosterInThread(
  roomIds: readonly string[],
  thread: string,
): Promise<string | null> {
  const [row] = await db
    .select({ roomId: supportActions.roomId })
    .from(supportActions)
    .where(
      and(
        inArray(supportActions.roomId, [...roomIds]),
        eq(supportActions.thread, thread),
        eq(supportActions.kind, 'reply'),
        eq(supportActions.actorKind, 'session'),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(1);
  return row?.roomId ?? null;
}
