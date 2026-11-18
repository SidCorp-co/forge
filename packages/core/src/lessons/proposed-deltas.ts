// What lessons proposed for the capability cards, as one project may be taught it (ISS-1251): a
// proposed delta reaches the project that learned it and no other. Its writer
// (`card-freshness.ts:proposeCardDelta`) always names one, so a delta naming none is one whose project
// was deleted (the key is ON DELETE SET NULL), and reaches nobody. The run's map, the checkout
// orientation, the Tier-0 maps and `forge_describe` all read it from here.
// Kept apart from `card-freshness.ts` so a suite that stubs the ledger's read stubs it under this too.

import { type CardFreshness, cardFreshness } from './card-freshness.js';

type ProposedDelta = CardFreshness['proposedDeltas'][number];

/**
 * By card id, the deltas proposed for each card that reach a project: its own, and none where no
 * project is named. For the cards asked, or every card any row names.
 */
export async function proposedDeltasFor(
  projectId: string | null,
  cardIds?: readonly string[],
): Promise<Map<string, ProposedDelta[]>> {
  return new Map(
    (await cardFreshness(cardIds)).map((f) => [
      f.cardId,
      f.proposedDeltas.filter((d) => projectId !== null && d.projectId === projectId),
    ]),
  );
}

/** By card id, the situations this project's lessons folded into a card its code does not carry yet. */
export async function proposedSituations(
  projectId: string,
  cardIds?: readonly string[],
): Promise<Map<string, string[]>> {
  const deltas = await proposedDeltasFor(projectId, cardIds);
  return new Map(
    [...deltas].map(([cardId, ds]) => [
      cardId,
      ds.filter((d) => d.field === 'situation').map((d) => d.text),
    ]),
  );
}
