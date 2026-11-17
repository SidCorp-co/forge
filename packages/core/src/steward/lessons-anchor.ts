// What a lesson's anchor may name, as every steward step that names one reads it (ISS-1251 c4): the
// cards offered, as a prompt lists them, and the anchor a step takes from its model's answer.

import { lessonAnchorSchema } from '@forge/contracts/lessons';

/** The cards a step offers an anchor from: the nearest the lesson's words (`lessonsPorts().cardsLike`). */
export type CardChoices = readonly { id: string; purpose: string }[];

/**
 * The anchor a step takes from its model's answer: a valid anchor, and a card one only where the step
 * offered that card (or `named` names it: a confusion's raiser saying which card the lesson is about).
 * Round 1's prompt offered no cards and gave `card:support.member` as its example, and the steward
 * anchored ten unrelated lessons there (ISS-1251 c4): a card the step never offered is a guess, and
 * is not taken, so no example and no card the model merely knows can draw lessons to it.
 */
export function takenAnchor(
  anchor: string | null | undefined,
  offered: CardChoices,
  named = '',
): string | null {
  const parsed = anchor ? lessonAnchorSchema.safeParse(anchor) : null;
  if (!parsed?.success) return null;
  if (!parsed.data.startsWith('card:')) return parsed.data;
  const id = parsed.data.slice('card:'.length);
  return offered.some((c) => c.id === id) || named.includes(parsed.data) ? parsed.data : null;
}

/** The cards an anchor may name, as a prompt lists them: each by its id and what its door does. */
export const cardChoices = (cards: readonly { id: string; purpose: string }[]): string =>
  cards.length > 0
    ? `Cards whose doors read nearest it (an anchor names one of these, or none):\n${cards.map((c) => `- card:${c.id}: ${c.purpose}`).join('\n')}`
    : 'No card reads near it: anchor it to a requirement behaviour or code, or to none.';
