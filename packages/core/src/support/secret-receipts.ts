// The receipt of a secret a room agent asked for (ISS-1348 c3): once its slot is given a value
// through either door (its page, or the one-time write URL), every thread that asked hears so, as a
// fact handed to the room's session with the value's fingerprint and never the value. The session
// tells the person in its own words (agent-is-the-voice); core posts nothing. A thread is told once
// per fill, however many asks it made for that slot.

import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { deliverWaiting } from './dispatch.js';
import { knownThread } from './outcome.js';
import { type AskRow, fillAsks } from './secret-asks.js';
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

function filledNote(ask: AskRow, fingerprint: string, via: 'page' | 'presigned'): string {
  const how = via === 'presigned' ? 'the one-time write URL' : 'its page in Forge';
  return [
    `${slotLabelOf(ask)}, which this thread asked for with support.secret_link, now holds a value: it was set through ${how} (fingerprint ${fingerprint}).`,
    'Forge kept no part of it in chat. Tell the person once, in your own words, that it was received, naming that fingerprint, and go on with what it was for.',
    'Never ask for it again, never ask to see it, and never repeat it.',
  ].join(' ');
}

/** The `secret.slotFilled` consumer: each open ask for the slot is filled and its thread told. */
export async function tellSlotFilled(p: OutboxEventPayload<'secret.slotFilled'>): Promise<void> {
  const asks = await fillAsks(p.slot, {
    fingerprint: p.fingerprint,
    via: p.via,
    at: new Date(p.at),
  });
  const told = new Set<string>();
  for (const ask of asks) {
    const where = `${ask.roomId}\u0000${ask.thread}`;
    if (told.has(where)) continue;
    told.add(where);
    const room = await roomById(ask.roomId);
    if (!room) continue;
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: await knownThread(room, ask.thread),
      thread: ask.thread,
      kind: 'message_in',
      actorKind: 'core',
      input: { note: filledNote(ask, p.fingerprint, p.via) },
      externalId: `secret-filled:${ask.id}`,
    });
    await deliverWaiting(room.id);
  }
}
