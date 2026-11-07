// A member's chat account linked to their Forge user (REQ-75 r5; ISS-845), so the room's acts that
// run as the asker (`deliver`, an operations move) can name them. The session asks for it with the
// `link` act and is handed the link page to give the member; the member opens it signed in to Forge,
// where the chat server's address for the account is matched against theirs. No code passes through
// the room or the session, and core posts nothing: once the page confirms the link, the session is
// handed the fact to say in its own words. The owner a binding names is handed no page: his account is
// named by a project admin, or he links it from Forge himself, and an answer of his meanwhile is kept
// (ISS-976, `kept-answers.ts`).

import { and, desc, eq } from 'drizzle-orm';
import { resolveSpeaker, type SpeakerLinked, speakerLinkUrl } from '../assistant/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, isNamedOwner, supportConfigOf } from './grants.js';
import { ownerSetupStep, recordKeptAnswers } from './kept-answers.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { insertAction, type RoomRow, roomById, threadMembers } from './store.js';
import { roomAuth } from './thread.js';

const SOURCE = 'rocketchat';

/**
 * Whether a member of the thread is linked, and where not, the page they link on. Refused by name
 * when the member has not written in the thread.
 */
export async function linkMember(
  room: RoomRow,
  input: { thread: string; member: string },
): Promise<Outcome<{ linked: true } | { linked: false; url?: string; next: string }>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const members = await threadMembers(room.id, input.thread);
  const member = members.find((m) => m.key === input.member);
  if (!member) {
    return no(
      'SUPPORT_ASKER_NOT_IN_THREAD',
      '/member',
      `account ${input.member} has not written in this thread; its writers are ${members.map((m) => `${m.key} (${m.label ?? 'no name'})`).join(', ') || 'none'}`,
    );
  }
  const { namespace } = await roomAuth(room);
  // a naming holds in its project's own rooms; an operations room's acts reach past it (`ops-asker.ts`)
  const resolved = await resolveSpeaker(
    { source: SOURCE, namespace, externalId: member.key },
    room.kind === 'operations' ? undefined : room.projectId,
  );
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: 'link',
    input: { member: member.key },
    output: { linked: resolved.linked },
  });
  if (resolved.linked) return { ok: true, value: { linked: true } };
  // the owner the binding names is never asked to set anything up, so he is handed no page (ISS-976)
  if (isNamedOwner(grantsOf(await supportConfigOf(room)), member.key)) {
    return {
      ok: true,
      value: {
        linked: false,
        next: `@${member.label ?? member.key} is the owner this binding names: never hand him this page or ask him to link anything. ${await ownerSetupStep(room.projectId)}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      linked: false,
      url: speakerLinkUrl({ projectId: room.projectId, source: SOURCE, externalId: member.key }),
      next: `Give @${member.label ?? member.key} this link in your own words: they open it signed in to Forge, with the same email address as this chat account, and confirm. Where the chat account reports no address, a project admin names their Forge account instead (POST /api/projects/${room.projectId}/speaker-links/named). You are told here once it is linked.`,
    },
  };
}

/**
 * A link the page confirmed, or an account a project admin named (ISS-976), told to the session of
 * every room the account wrote in, in its latest thread there, to say in its own words; first, each
 * answer of theirs kept while they were no Forge account is recorded as theirs, and the room it was
 * kept in is told what became of it. A naming reaches only its own project's rooms. Nothing is posted.
 */
export async function tellLinked(linked: SpeakerLinked): Promise<void> {
  if (linked.source !== SOURCE) return;
  const recorded = await recordKeptAnswers(linked);
  const written = await db
    .select({ roomId: supportActions.roomId, thread: supportActions.thread })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.actorKind, 'member'),
        eq(supportActions.actorKey, linked.externalId),
      ),
    )
    .orderBy(desc(supportActions.createdAt))
    .limit(200);
  const latest = new Map<string, string>();
  for (const w of written) if (!latest.has(w.roomId)) latest.set(w.roomId, w.thread);
  for (const [roomId, kept] of recorded) if (!latest.has(roomId)) latest.set(roomId, kept.thread);
  const who = linked.label ? `@${linked.label}` : `account ${linked.externalId}`;
  const how = linked.projectId
    ? `${who} is now named by a project admin as their Forge account in this project`
    : `${who} is now linked to their Forge account`;
  for (const [roomId, thread] of latest) {
    const room = await roomById(roomId);
    if (!room) continue;
    if (linked.projectId && room.projectId !== linked.projectId && !recorded.has(roomId)) continue;
    // the account is one chat server's: a room on another server holds a different account
    const { namespace } = await roomAuth(room).catch(() => ({ namespace: null }));
    if (namespace !== linked.namespace) continue;
    const note = [
      `${how}: what this room does as them is done as that account, within what it may do. Tell them if they are waiting on it.`,
      ...(recorded.get(roomId)?.lines ?? []),
      `An answer of theirs refused before and not named here was not kept: cite it again with support.answer_question, and it is recorded as theirs, with nothing asked of them again.`,
    ].join(' ');
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: await knownThread(room, thread),
      thread,
      kind: 'message_in',
      actorKind: 'core',
      input: { note },
      externalId: `linked:${linked.externalId}:${Date.now()}`,
    });
    await deliverWaiting(room.id).catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: a link note was not handed on'),
    );
  }
}
