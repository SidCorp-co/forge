// What waits on the owner is put to him by his project's agent, unasked (ISS-1243 item 23, owner
// 2026-11-16: the requests waiting on him on Activity should be raised by the agent so he settles
// them in the conversation). `owner-owed.ts` showed a turn only his open questions, and only once he
// had written. Here every decision his Needs you lists (a question, a release to approve or return
// with its carried criteria, a cut, a requirement to accept, a design to approve) is handed to the
// project's channel agent as a task, once per item, the moment a sweep reads it as his: core writes
// the task into a thread no member wrote in, never into a room. The agent writes the words, plain,
// with the options and its recommendation, and puts them to him with `raise_owed`, which posts them
// in the project's technical channel (`technical-channel.ts:raiseTechnical`, item 13) and only there,
// once. His reply in chat settles it, through the act made as him (`answer_question`,
// `release_decision`, `owner_forge_act`).

import { createHash } from 'node:crypto';
import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { and, eq } from 'drizzle-orm';
import { readNeedsYouDecisions } from '../assistant/index.js';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { findProjectSlugs } from '../projects/index.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { questionOfOwed, secondRaise } from './one-raise.js';
import { forgeUserOfWriter } from './ops-asker.js';
import { knownThread, no, type Outcome } from './outcome.js';
import { ownerUsername } from './owner-consent.js';
import { insertAction, type RoomRow, roomsHoldingSessions } from './store.js';
import { readTechnicalTurn, speakTo } from './technical-turn.js';
import { roomAuth, threadConversationOf } from './thread.js';

/** The prefix of a thread an owed item is handed in. */
const OWED = 'owed-';
/** The act a raise is recorded under, once per item. */
const RAISE = 'raise_owed';
/** How many items one sweep hands one project's agent: the rest go on the next sweep. */
const PER_SWEEP = 10;

/** The raise of builder B's technical channel, as `technical-channel.ts:raiseTechnical` takes it. */
export type TechnicalRaise = (
  room: RoomRow,
  input: { thread: string; need: 'approval'; text: string; answers?: string | undefined },
) => Promise<
  Outcome<{ channel: 'thread' | 'dm'; rid: string; messageId: string | null; landed?: string }>
>;

let raise: TechnicalRaise | null = null;

/** Wired at boot to `technical-channel.ts:raiseTechnical`, the one door to the technical channel. */
export function provideTechnicalRaise(r: TechnicalRaise): void {
  raise = r;
}

/** The thread one owed item is handed in: the same for the item on every sweep. */
export const owedThreadOf = (decisionId: string): string =>
  `${OWED}${createHash('sha256').update(decisionId).digest('hex').slice(0, 24)}`;

/**
 * The task the agent reads: what to do first, then the item as the Needs-you read holds it. It names
 * the language he reads and his name before the agent writes a word (ISS-1299).
 */
function taskNote(thread: string, project: string, d: NeedsYouDecision, to: string): string {
  const answers = d.answers.map(
    (a) =>
      `${a.id} "${a.label}"${a.effect ? ` (${a.effect})` : ''}${a.needsReason ? ', takes his reason' : ''}`,
  );
  const recommended = d.recommended
    ? `Recommended: ${d.recommended.answerId}, because ${d.recommended.why}`
    : `No recommendation from the record (${d.noRecommendation}); give yours from what you read.`;
  return [
    `An item on ${project} waits on the owner (${d.key}, ${d.id}). Put it to him now with support.raise_owed { thread: "${thread}", text }: ${to}; plain words with no code, what it is, the options and your recommendation, short. It is posted in the project's technical channel, once; post it nowhere else.`,
    'When he answers, in any words, settle it as him citing his own message (support.answer_question for a question, support.release_decision for a release decision, support.owner_forge_act for any other Forge act he asks: a requirement, a design, a release cut or approval with carry, a merge mark, config, an ecosystem invite or a membership answer); never send him to a page. An act no door makes from chat is refused naming where it is made: tell him that in one line, never that it is being done.',
    // the item's words are its writers' (a master's or a run's), data framed, never core's (ISS-1425)
    markUntrusted(
      [
        `What is asked: ${d.question}`,
        `What it changes: ${d.changes}. Impact: ${d.impact}.`,
        `Options: ${answers.join('; ')}.`,
        recommended,
      ].join('\n'),
      { source: 'the item as the record holds it' },
    ),
  ].join('\n');
}

/** The agent room a project's owed items are handed in: its owner's room, else its first. */
async function agentRoomOf(rooms: RoomRow[]): Promise<RoomRow | null> {
  for (const room of rooms) {
    const ownerRoom = (await supportConfigOf(room))?.ownerRoom;
    if (ownerRoom === room.rid) return room;
  }
  return rooms[0] ?? null;
}

/** Hand the agent of `room`'s project each item his Needs you lists that it was not handed yet. */
export async function handOwnerOwed(room: RoomRow): Promise<{ handed: number }> {
  const owner = grantsOf(await supportConfigOf(room)).owner;
  if (!owner) return { handed: 0 };
  const person = await forgeUserOfWriter(room, { key: owner, label: null });
  if (!person.ok) {
    logger.warn(
      { roomId: room.id, refusal: person.refusals[0]?.code },
      'support: the owner this binding names is no Forge account, so nothing owed to him is raised',
    );
    return { handed: 0 };
  }
  const decisions = await readNeedsYouDecisions(room.projectId, person.value.userId);
  const { namespace } = await roomAuth(room);
  const slug = (await findProjectSlugs([room.projectId])).get(room.projectId) ?? room.projectId;
  const to = speakTo(
    await readTechnicalTurn(room, null, {
      key: owner,
      name: await ownerUsername(room.projectId, owner),
    }),
  );
  let handed = 0;
  for (const d of decisions) {
    if (handed >= PER_SWEEP) break;
    const thread = owedThreadOf(d.id);
    // unique per room and message id: an item handed before is not handed again
    const [seen] = await db
      .select({ id: supportActions.id })
      .from(supportActions)
      .where(
        and(
          eq(supportActions.roomId, room.id),
          eq(supportActions.kind, 'message_in'),
          eq(supportActions.externalId, thread),
        ),
      )
      .limit(1);
    if (seen) continue;
    const conversation = await threadConversationOf(room, namespace, thread);
    const row = await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: conversation.id,
      thread,
      kind: 'message_in',
      actorKind: 'core',
      input: { note: taskNote(thread, slug, d, to), owed: d.id, key: d.key },
      externalId: thread,
    });
    if (row) handed += 1;
  }
  if (handed > 0) await deliverWaiting(room.id);
  return { handed };
}

/** A process timer: every project's agent is handed what waits on its owner, once per item. */
export async function handAllOwnerOwed(): Promise<void> {
  const byProject = new Map<string, RoomRow[]>();
  for (const room of await roomsHoldingSessions()) {
    if (room.kind !== 'agent') continue;
    byProject.set(room.projectId, [...(byProject.get(room.projectId) ?? []), room]);
  }
  for (const rooms of byProject.values()) {
    const room = await agentRoomOf(rooms);
    if (!room) continue;
    await handOwnerOwed(room).catch((err: unknown) =>
      logger.error({ err, roomId: room.id }, 'support: what waits on the owner was not handed on'),
    );
  }
}

/**
 * The agent puts a handed item to the owner in the project's technical channel, once: refused by
 * name in a thread no item was handed in, or for an item already raised.
 */
export async function raiseOwed(
  room: RoomRow,
  input: { thread: string; text: string; answers?: string | undefined },
): Promise<Outcome<{ raised: true; channel: 'thread' | 'dm'; next: string }>> {
  const [task] = input.thread.startsWith(OWED)
    ? await db
        .select({ input: supportActions.input })
        .from(supportActions)
        .where(
          and(
            eq(supportActions.roomId, room.id),
            eq(supportActions.kind, 'message_in'),
            eq(supportActions.externalId, input.thread),
          ),
        )
        .limit(1)
    : [];
  if (!task) {
    return no(
      'SUPPORT_OWED_UNKNOWN',
      '/thread',
      `${input.thread} is no thread an item waiting on the owner was handed to you in; raise the owed- thread you were handed. Nothing was raised.`,
    );
  }
  const [raised] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.thread, input.thread),
        eq(supportActions.kind, 'operation'),
        eq(supportActions.tool, RAISE),
      ),
    )
    .limit(1);
  if (raised) {
    return no(
      'SUPPORT_OWED_ALREADY_RAISED',
      '/thread',
      `this item was already put to the owner in the technical channel; it is raised once. Nothing was raised again.`,
    );
  }
  // a question he was already asked with ask_owner, from any thread, is not put to him again (ISS-1347)
  const owed = (task.input as { owed?: unknown } | null)?.owed;
  const question = questionOfOwed(owed);
  const again = question
    ? await secondRaise<never>(room, question, 'SUPPORT_OWED_ALREADY_RAISED', input.thread)
    : null;
  if (again) return again;
  if (!raise) {
    throw new Error(
      'support: no technical channel raise was provided; registerSupportRooms wires provideTechnicalRaise(raiseTechnical)',
    );
  }
  const out = await raise(room, {
    thread: input.thread,
    need: 'approval',
    text: input.text,
    answers: input.answers,
  });
  if (!out.ok) return out;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: await knownThread(room, input.thread),
    thread: input.thread,
    kind: 'operation',
    actorKind: 'session',
    tool: RAISE,
    input: { owed, ...(input.answers ? { answers: input.answers } : {}) },
    output: out.value,
  });
  return {
    ok: true,
    value: {
      raised: true,
      channel: out.value.channel,
      ...(out.value.landed ? { landed: out.value.landed } : {}),
      next: 'Raised in the technical channel. When he answers there, do it as him, citing his message.',
    },
  };
}
