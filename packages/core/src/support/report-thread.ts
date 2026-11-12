// A room's report thread (ISS-1224, owner 2026-11-12, repeating the rulings of 2026-10-31 and
// 2026-11-01): a bot never posts a report at a work room's top level. A master's post naming no
// thread (`master-post.ts`), core's room-down line (`last-resort.ts`) and a scheduled check's finding
// (`checks.ts`, ISS-1227) go in the room's report thread instead: the one a person named for the
// room's reports (`report-thread-route.ts`), else the one standing thread Forge opens once per room,
// with one short anchor line at the top level, and keeps. Where no thread can be had, nothing is posted: the caller refuses or records it by name.

import { eq } from 'drizzle-orm';
import { confidentLanguageOf } from '../conversations/index.js';
import { db } from '../db/client.js';
import { supportRooms } from '../db/schema-support.js';
import { FIXED_REPLY_CONSTANT } from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { readContentLanguage } from '../project-config/index.js';
import { no, type Outcome } from './outcome.js';
import { insertAction, type RoomRow } from './store.js';
import { postForTopLevel } from './thread.js';

/** The one line that opens Forge's standing report thread, in the room's language. */
export const REPORT_THREAD_ANCHORS: Readonly<Record<'vi' | 'en', string>> = {
  vi: 'Báo cáo của trợ lý', // i18n-allow: core's report-thread anchor, in the room's language (ISS-1224)
  en: 'Assistant reports',
};

/** The tool the anchor's record names. */
export const REPORT_THREAD_TOOL = 'report_thread';

/**
 * The room's language for a line core writes: the project's content language where its document
 * declares one, else Vietnamese where one of `texts` reads Vietnamese, else English. The project
 * decides first; the texts decide only for a project that never said.
 */
export async function roomLanguage(room: RoomRow, texts: readonly string[]): Promise<'vi' | 'en'> {
  const setting = await readContentLanguage(room.projectId);
  if (setting.source === 'document') {
    return setting.contentLanguage.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  }
  return texts.some((t) => confidentLanguageOf(t) === 'vi') ? 'vi' : 'en';
}

/** The room's report thread as its row holds it now, and who set it; null with none. */
export async function reportThreadOf(
  roomId: string,
): Promise<{ thread: string; by: 'person' | 'forge' } | null> {
  const [row] = await db
    .select({ thread: supportRooms.reportThread, by: supportRooms.reportThreadBy })
    .from(supportRooms)
    .where(eq(supportRooms.id, roomId))
    .limit(1);
  return row?.thread && row.by ? { thread: row.thread, by: row.by } : null;
}

/** Name a thread a person wrote in as the room's report thread, replacing whichever stood. */
export async function nameReportThread(roomId: string, thread: string): Promise<void> {
  await db
    .update(supportRooms)
    .set({ reportThread: thread, reportThreadBy: 'person' })
    .where(eq(supportRooms.id, roomId));
}

/**
 * The refusal where a room has no report thread and Forge could not open one. `named` says the
 * caller can pass a thread of its own; a scheduled check's finding cannot (ISS-1227).
 */
export function needsThread(room: RoomRow, why: string, named = true): Outcome<never> {
  const instead = named ? 'Pass `thread` to post in a thread of the room, or name' : 'Name';
  return no(
    'SUPPORT_POST_NEEDS_THREAD',
    '/thread',
    `${room.rid} has no report thread, and the line opening one could not be posted (${why}), so the post would land at its top level. ${instead} the room's report thread, one people wrote in: PUT /api/projects/${room.projectId}/support/rooms/${room.id}/report-thread with { thread }. Nothing was posted.`,
  );
}

/**
 * The room's report thread: the one standing, or Forge's own, opened now with one anchor line at the
 * top level in the room's language (`texts` decide it where the project never said). Opened once:
 * two posts racing wait on one lock, and the second finds the first's thread. Where the anchor
 * cannot be posted, `SUPPORT_POST_NEEDS_THREAD`, and nothing stands posted.
 */
export async function reportThreadFor(
  room: RoomRow,
  texts: readonly string[],
  opts: { named?: boolean } = {},
): Promise<Outcome<string>> {
  const standing = await reportThreadOf(room.id);
  if (standing) return { ok: true, value: standing.thread };
  try {
    const got = await db.transaction(async (tx) => {
      await lockXact(tx, 'supportRoom', `report-thread:${room.id}`);
      const [row] = await tx
        .select({ thread: supportRooms.reportThread })
        .from(supportRooms)
        .where(eq(supportRooms.id, room.id));
      if (row?.thread) return { thread: row.thread, opened: null };
      const anchor = REPORT_THREAD_ANCHORS[await roomLanguage(room, texts)];
      const out = await postForTopLevel({
        room,
        text: anchor,
        proof: FIXED_REPLY_CONSTANT,
        to: null,
      });
      if (!out.ok) throw new Error(out.refusals.map((r) => r.detail).join('; '));
      const thread = out.value.messageId;
      if (!thread) throw new Error('the chat server named no message id for it');
      await tx
        .update(supportRooms)
        .set({ reportThread: thread, reportThreadBy: 'forge' })
        .where(eq(supportRooms.id, room.id));
      return { thread, opened: { conversationId: out.value.conversationId, anchor } };
    });
    if (got.opened) await recordOpened(room, { thread: got.thread, ...got.opened });
    return { ok: true, value: got.thread };
  } catch (err) {
    logger.error({ err, roomId: room.id }, "support: the room's report thread could not be opened");
    return needsThread(room, err instanceof Error ? err.message : String(err), opts.named);
  }
}

/** Forge's anchor, recorded as core's act in the room it opened the thread in. */
async function recordOpened(
  room: RoomRow,
  opened: { thread: string; conversationId: string; anchor: string },
): Promise<void> {
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: opened.conversationId,
    thread: opened.thread,
    kind: 'operation',
    actorKind: 'core',
    tool: REPORT_THREAD_TOOL,
    input: { text: opened.anchor },
    externalId: opened.thread,
  });
}
