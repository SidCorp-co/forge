// A lesson anchored to a capability card names one a door carries (ISS-1251 c4). The steward drafted
// L-113 on `card:79bf44c4-…`, an item's uuid, which no card carries, and anchored L-55, L-92 and
// L-104 on `card:support.member`, the one card its prompt gave as an example: an anchor that names
// no card can never be invalidated by the change that moves what the lesson is about, nor folded into
// it. Refused by name wherever an anchor is written, with the shape that stands.

import { LESSON_ANCHOR_SHAPE, lessonAnchorKind } from '@forge/contracts/lessons';
import { lessonsPorts } from './ports.js';
import { refuse } from './refuse.js';

/** Throws LESSON_ANCHOR_UNKNOWN where `anchor` is a card no door carries; any other anchor stands. */
export async function refuseUnknownCard(anchor: string | undefined, path: string): Promise<void> {
  if (!anchor || lessonAnchorKind(anchor) !== 'card') return;
  const id = anchor.slice('card:'.length);
  if (await lessonsPorts().cardOf(id)) return;
  throw refuse(
    'LESSON_ANCHOR_UNKNOWN',
    `${anchor} names no capability card a door carries, so no change could invalidate the lesson and no card could take it in; name the card of the door the lesson is about, by the id forge_find answers, or another anchor: ${LESSON_ANCHOR_SHAPE}`,
    path,
  );
}
