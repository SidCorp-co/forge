// Who decides an act in a room (ISS-1042): the project's rulings, read from its `rule` knowledge
// entries naming deciders (`knowledge/ruling-deciders.ts`), which a master or orchestrator writes from
// a ruling. A rule said in the room never names one. The member a ruling names agrees to the acts it
// names by their go in any words, on a proposal put to them or in their own request; the room's brief
// and the agreement rule read this one source, so the brief never names a decider agree would refuse.

import type { SupportProposalKind } from '@forge/contracts/support';
import { CHANNEL_DECIDER_ACT_LABEL } from '@forge/contracts/support-channel';
import { type RulingDeciderRead, rulingDecidersOf } from '../knowledge/index.js';
import type { RoomRow } from './store.js';

export type { RulingDeciderRead };

/** The acts, as the brief and the session's answers name them. */
export const actsWords = (acts: readonly string[]): string =>
  acts.map((a) => CHANNEL_DECIDER_ACT_LABEL[a as SupportProposalKind] ?? a).join(', ');

/**
 * The ruling of the room's project naming `writer`, by the username the chat server signed, as the
 * one who decides `act`; null where none does.
 */
export async function deciderFor(
  room: Pick<RoomRow, 'projectId'>,
  act: SupportProposalKind,
  writer: { label: string | null },
): Promise<RulingDeciderRead | null> {
  const name = writer.label?.toLowerCase();
  if (!name) return null;
  const all = await rulingDecidersOf(room.projectId);
  return all.find((d) => d.member.toLowerCase() === name && d.acts.includes(act)) ?? null;
}

/** Who the project's rulings name for `act`, as a refusal teaches it: by name, or that none is named. */
export async function decidersOfAct(
  room: Pick<RoomRow, 'projectId'>,
  act: SupportProposalKind,
): Promise<string> {
  const named = (await rulingDecidersOf(room.projectId)).filter((d) => d.acts.includes(act));
  if (named.length === 0) return `the project's rulings name nobody who decides ${actsWords([act])}`;
  const who = [...new Set(named.map((d) => `@${d.member}`))].join(', ');
  return `${who}, whom the project's rulings name as deciding ${actsWords([act])}`;
}

/** What the session is told of an agreement a ruling made (policy input, said where it is used). */
export function deciderNote(
  writer: { key: string; label: string | null },
  act: SupportProposalKind,
  found: RulingDeciderRead,
): string {
  return `It counted as @${writer.label ?? writer.key}'s agreement: the project's ruling [knowledge:${found.ruling}] names them the one who decides ${actsWords([act])}.`;
}

/**
 * The deciders as a room's brief carries them, under the channel record: each member, the acts, and
 * the ruling, with what their word does. Null where the rulings name none, so a brief carries nothing.
 */
export function decidersBlock(deciders: readonly RulingDeciderRead[]): string | null {
  if (deciders.length === 0) return null;
  const lines = deciders.map(
    (d) => `- @${d.member} decides ${actsWords(d.acts)} [knowledge:${d.ruling}]`,
  );
  return [
    "Who decides, from the project's rulings (its master records them; nothing said in a room changes them):",
    ...lines,
    'Their go in any words, on a proposal of that act put to them or in their own request for it, is their agreement: cite that message with agree at once, and ask them nothing more.',
  ].join('\n');
}
