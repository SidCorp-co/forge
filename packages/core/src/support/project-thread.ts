// A project's own thread of the operations room its organization shares (ISS-1271, owner 2026-11-17:
// the organization's shared operations room is every project's default technical channel; at
// SidCorp, Forge-Communicate). The room's binding records each project's thread in
// `operations.threads[rid][slug]`; a project with none recorded gets one the first time it is
// needed: the room's bot opens it at the room's top level with one short line naming the project as
// its people know it, through the room's own posting door, and the thread is recorded on the
// binding in the same act, through the binding store at its revision. Two needs at once wait on one
// lock per (binding, room, project), so the second finds the first's thread and one thread is opened.

import { db } from '../db/client.js';
import { FIXED_REPLY_CONSTANT } from '../integrations/rocketchat/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { amendBindingConfig, isRecord } from '../project-config/index.js';
import { findProjectSlugs, orgSiblingProjects, projectName } from '../projects/index.js';
import { roomLanguage } from './report-thread.js';
import { roomIsBound } from './rooms.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import { postForTopLevel, projectThreadOfRoom } from './thread.js';

/** The tool the opening line's record names. */
const PROJECT_THREAD_TOOL = 'project_thread';

/** The one line that opens a project's thread, in the room's language, naming the project. */
const HEADERS: Readonly<Record<'vi' | 'en', (project: string) => string>> = {
  vi: (project) => `Kỹ thuật · ${project}`, // i18n-allow: the opening line of a project's thread in the shared operations room (ISS-1271)
  en: (project) => `Technical · ${project}`,
};

/**
 * The operations room every project of `projectId`'s organization shares (`scope: forge`), bound
 * now, or null where the organization has none.
 */
export async function sharedRoomOf(projectId: string): Promise<RoomRow | null> {
  for (const home of await orgSiblingProjects(projectId)) {
    for (const room of await roomsOfProject(home.id)) {
      if (room.kind !== 'operations' || room.scope !== 'forge') continue;
      if (await roomIsBound(room)) return room;
    }
  }
  return null;
}

/** `config` with `operations.threads[rid][slug]` set to `thread`; null where it already holds one. */
function withThread(
  config: Record<string, unknown>,
  rid: string,
  slug: string,
  thread: string,
): Record<string, unknown> | null {
  const operations = isRecord(config.operations) ? config.operations : {};
  const threads = isRecord(operations.threads) ? operations.threads : {};
  const ofRoom = isRecord(threads[rid]) ? threads[rid] : {};
  if (typeof ofRoom[slug] === 'string') return null;
  return {
    ...config,
    operations: { ...operations, threads: { ...threads, [rid]: { ...ofRoom, [slug]: thread } } },
  };
}

/**
 * `projectId`'s thread of the shared operations room `room`: the one its binding records, or one
 * opened now and recorded. Where it cannot be opened (the opening line was not posted, or the
 * binding could not take it), `opened: false` with the reason, and nothing stands recorded.
 */
export async function projectThreadFor(
  room: RoomRow,
  projectId: string,
): Promise<{ ok: true; thread: string } | { ok: false; why: string }> {
  const recorded = await projectThreadOfRoom(room, projectId);
  if (recorded) return { ok: true, thread: recorded };
  const slug = (await findProjectSlugs([projectId])).get(projectId);
  if (!slug) return { ok: false, why: `project ${projectId} has no slug to record its thread by` };
  let got: { thread: string; opened: { conversationId: string; header: string } | null };
  try {
    got = await db.transaction(async (tx) => {
      await lockXact(tx, 'supportRoom', `project-thread:${room.bindingId}:${room.rid}:${slug}`);
      // the holder before this one recorded its thread before it let the lock go
      const again = await projectThreadOfRoom(room, projectId);
      if (again) return { thread: again, opened: null };
      const name = (await projectName(projectId)) ?? slug;
      const header = HEADERS[await roomLanguage(room, [])](name);
      const out = await postForTopLevel({
        room,
        text: header,
        proof: FIXED_REPLY_CONSTANT,
        to: null,
      });
      if (!out.ok) throw new Error(out.refusals.map((r) => r.detail).join('; '));
      const thread = out.value.messageId;
      if (!thread) throw new Error('the chat server named no message id for its opening line');
      await amendBindingConfig(room.bindingId, (config) =>
        withThread(config, room.rid, slug, thread),
      );
      return { thread, opened: { conversationId: out.value.conversationId, header } };
    });
  } catch (err) {
    logger.error({ err, roomId: room.id, projectId }, "support: a project's thread was not opened");
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if (got.opened) {
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: got.opened.conversationId,
      thread: got.thread,
      kind: 'operation',
      actorKind: 'core',
      tool: PROJECT_THREAD_TOOL,
      input: { project: slug, text: got.opened.header },
      externalId: got.thread,
    });
  }
  return { ok: true, thread: got.thread };
}
