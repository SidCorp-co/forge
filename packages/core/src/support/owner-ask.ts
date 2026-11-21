// A channel agent's question to the owner, through the project's one technical channel (REQ-77
// BC-12, ISS-1246; owner 2026-11-15: every ask of the owner goes there and nowhere else). The agent
// asks from the thread the question arose in; the ask is posted in the technical channel alone (the
// project's thread of the shared operations room by default, or a direct message, `technicalChannelOf`)
// and recorded on the asker's thread naming where it went. The owner's reply there, by the id the
// chat server signed for its writer, is the answer: a reply to the ask's own line answers that ask,
// and any other message of his there answers the one ask waiting there. It reaches the asking session
// as its next message in the asker's thread (marked as the answer to that question), the issue the
// question named as a note carrying his own words, and, where the agent asked on a master's behalf,
// the Forge question it named (ISS-871): recorded as that question's answer, as the owner's linked
// Forge account, through the questions door (`answerAs`), whose `question.answered` wakes the master
// who asked. Nobody else's message answers it, whatever it says: who wrote it is the server's word,
// never the text's. Both halves are `routed` actions of the asker's thread, so no state lives anywhere
// the record does not.

import { granters, grantsOf, supportConfigOf } from './grants.js';
import { secondRaise } from './one-raise.js';
import { projectsInScope } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import { issueInReach, questionRefusal } from './owner-ask-targets.js';
import { ownerUsername } from './owner-consent.js';
import { handedAsk } from './question-task.js';
import { isQuestionThread } from './rules.js';
import { insertAction, type RoomRow, threadMembers } from './store.js';
import { postTechnical, screenedTechnical, technicalChannelOf } from './technical-channel.js';
import { scrubbedForRoom } from './thread.js';

/** The tool an ask is recorded under on the asker's thread. */
export const ASK = 'ask_owner';

export interface AskInput {
  question: string;
  /** The issue key the answer is also written on. */
  record: string | null;
  issueId: string | null;
  /** The master's Forge question the answer is recorded on (ISS-871); absent on an older ask. */
  questionId?: string | null;
  /** The parked question's thread it was handed in (ISS-873), where it was asked from it. */
  handedIn?: string;
}

/** Where an ask went in the technical channel, as its `routed` action's output keeps it. */
export interface AskedAt {
  owner: string;
  mentioned: boolean;
  channel: 'thread' | 'dm';
  /** The room it was posted in: the shared operations room, or the direct message. */
  rid: string;
  /** The project's thread of the shared room it was posted in; null in a direct message. */
  thread: string | null;
  messageId: string | null;
}

/** An asker's thread: a member wrote in it, never the top-level post of an announcement. */
async function askersThread(
  room: RoomRow,
  thread: string,
): Promise<Outcome<{ thread: string; forgeQuestion?: string }>> {
  const known = (await threadMembers(room.id, thread)).length
    ? await knownThread(room, thread)
    : null;
  return known ? { ok: true, value: { thread } } : threadUnknown(thread);
}

/**
 * Ask the owner the binding names, in the project's technical channel and in no other room
 * (ISS-1246). Refused by name, nothing posted, when the room is not a channel agent's, the binding
 * names no owner, the thread is unknown, the issue or question the answer should be written on is
 * not one this agent follows, or the technical channel cannot be reached (naming the key that fixes it).
 */
export async function askOwner(
  room: RoomRow,
  request: {
    thread: string;
    question: string;
    record?: string | undefined;
    forgeQuestion?: string | undefined;
  },
): Promise<
  Outcome<{
    messageId: string | null;
    mentioned: boolean;
    record: string | null;
    forgeQuestion: string | null;
  }>
> {
  if (room.kind !== 'agent') {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      "ask_owner is a channel agent's act: this room's binding carries no `agent` block, so it names no owner to ask",
    );
  }
  const owner = grantsOf(await supportConfigOf(room)).owner;
  if (!owner) {
    return no(
      'SUPPORT_OWNER_NOT_NAMED',
      '/action',
      `this agent's binding names no owner, so nobody was asked: name the owner's Rocket.Chat user id in its grant; ${await granters(room.projectId)}`,
    );
  }
  // a parked question handed to this agent is asked from the thread it was handed in (ISS-873)
  const handed = isQuestionThread(request.thread);
  const where = handed
    ? await handedAsk(room, request.thread)
    : await askersThread(room, request.thread);
  if (!where.ok) return where;
  const input = {
    ...request,
    thread: where.value.thread,
    forgeQuestion: where.value.forgeQuestion ?? request.forgeQuestion,
  };
  // one Forge question is put to him once, by either act and from any thread (ISS-1347)
  const again = input.forgeQuestion
    ? await secondRaise<never>(
        room,
        input.forgeQuestion,
        'SUPPORT_OWNER_ALREADY_ASKED',
        input.thread,
      )
    : null;
  if (again) return again;
  const conversationId = handed ? null : await knownThread(room, input.thread);
  // the issue and the question may be any project's the agent follows (ISS-874)
  const reach = await projectsInScope(room);
  const issue = input.record ? await issueInReach(reach, input.record) : null;
  if (input.record && !issue) {
    return no(
      'SUPPORT_OWNER_RECORD_UNKNOWN',
      '/record',
      `${input.record} names no issue of the projects this agent follows (${reach.map((p) => p.slug).join(', ')}), so the answer would be written nowhere; nothing was asked`,
    );
  }
  const notAnswerable = input.forgeQuestion
    ? await questionRefusal(
        reach.map((p) => p.id),
        input.forgeQuestion,
      )
    : null;
  if (notAnswerable) {
    return no(
      'SUPPORT_OWNER_QUESTION_UNKNOWN',
      '/forgeQuestion',
      `${notAnswerable}, so the owner's answer would be recorded nowhere; nothing was asked`,
    );
  }
  // in the shared thread the owner is named; a direct message is his alone
  const shared = (await technicalChannelOf(room.projectId)).kind === 'thread';
  const username = shared ? await ownerUsername(room.projectId, owner) : null;
  // the question is the agent's own words, after a plain lead naming the project (ISS-1249), the
  // whole line screened; the owner's reply in the channel counts as the answer by the kernel rule
  // (`settleOwnerAnswer`), read from the routed action below, never from the posted text
  const words = await scrubbedForRoom(room, input.question);
  const admitted = await screenedTechnical(
    room,
    { conversationId, thread: input.thread, tool: ASK },
    words,
    username,
  );
  if (!admitted.ok) return admitted;
  const posted = await postTechnical(room, admitted.value.text, '/action');
  if (!posted.ok) return posted;
  const asked: AskInput = {
    question: input.question,
    record: input.record ?? null,
    issueId: issue?.id ?? null,
    questionId: input.forgeQuestion ?? null,
    ...(handed ? { handedIn: request.thread } : {}),
  };
  const at: AskedAt = { owner, mentioned: username !== null, ...posted.value };
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId,
    thread: input.thread,
    kind: 'routed',
    actorKind: 'session',
    tool: ASK,
    input: asked,
    output: at,
    externalId: posted.value.messageId,
  });
  return {
    ok: true,
    value: {
      messageId: posted.value.messageId,
      mentioned: at.mentioned,
      record: asked.record,
      forgeQuestion: asked.questionId ?? null,
    },
  };
}
