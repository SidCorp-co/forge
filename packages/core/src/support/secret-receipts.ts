// The receipt of a secret a room agent asked for (ISS-1348 c3): once its slot is given a value
// through either door (its page, or the one-time write URL), every thread that asked hears so, as a
// fact handed to the room's session with the value's fingerprint (never posted) and never the value. The session
// tells the person in its own words (agent-is-the-voice); core posts nothing. A thread is told once
// per fill, however many asks it made for that slot.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { deliverWaiting } from './dispatch.js';
import { knownThread } from './outcome.js';
import { type AskRow, fillAsks, openAsksOfSlot } from './secret-asks.js';
import { insertAction, roomById } from './store.js';

/** The slot an ask names, in the words the note says it with. */
export function slotLabelOf(ask: Pick<AskRow, 'kind' | 'slot'>): string {
  const s = ask.slot;
  if (ask.kind === 'variable') {
    return `variable ${s.key} ${s.environment ? `at environment ${s.environment}` : 'for every environment'}`;
  }
  if (ask.kind === 'testing') {
    const [kind, name] = s.actor ? ['actor', s.actor] : ['service', s.service];
    return `testing profile ${s.profile}'s ${kind} ${name}`;
  }
  return `the credential of the ${s.provider} connection`;
}

export function filledNote(ask: AskRow, fingerprint: string, via: 'page' | 'presigned'): string {
  const how = via === 'presigned' ? 'the one-time write URL' : 'its page in Forge';
  return [
    `${slotLabelOf(ask)}, which this thread asked for with support.secret_link, now holds a value: it was set through ${how} (fingerprint ${fingerprint}).`,
    'Forge kept no part of it in chat. Tell the person once, in your own words, which secret was received (say what it is for, as the person knows it), and go on with what it was for. The fingerprint is for Forge\u2019s records: never post it.',
    'Never ask for it again, never ask to see it, and never repeat it.',
  ].join(' ');
}

/**
 * The `secret.slotFilled` consumer: each thread with open asks for the slot is told once, its asks
 * filled in the transaction that writes its note, so a fault leaves them open for the event's retry.
 */
export async function tellSlotFilled(p: OutboxEventPayload<'secret.slotFilled'>): Promise<void> {
  const fill = { fingerprint: p.fingerprint, via: p.via, by: p.by, at: new Date(p.at) };
  const threads = new Map<string, AskRow[]>();
  for (const ask of await openAsksOfSlot(p.slot)) {
    const where = `${ask.roomId}\u0000${ask.thread}`;
    threads.set(where, [...(threads.get(where) ?? []), ask]);
  }
  for (const [first, ...rest] of threads.values()) {
    if (!first) continue;
    const room = await roomById(first.roomId);
    if (!room) {
      logger.warn(
        { asks: [first, ...rest].map((a) => a.id), roomId: first.roomId, slot: p.slot },
        'support: a filled secret was asked for in a room that is gone; no thread is told',
      );
    }
    const conversationId = room ? await knownThread(room, first.thread) : null;
    const filled = await db.transaction(async (tx) => {
      const rows = await fillAsks(
        tx,
        [first, ...rest].map((a) => a.id),
        fill,
      );
      const ask = rows[0];
      if (ask && room) {
        await insertAction(
          {
            roomId: room.id,
            projectId: room.projectId,
            conversationId,
            thread: ask.thread,
            kind: 'message_in',
            actorKind: 'core',
            input: { note: filledNote(ask, p.fingerprint, p.via) },
            externalId: `secret-filled:${ask.id}`,
          },
          tx,
        );
      }
      return rows;
    });
    if (room && filled.length > 0) await deliverWaiting(room.id);
  }
}
