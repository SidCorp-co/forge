// Every capability card this build serves, read against the card ledger (`lib/card-changed.ts`): a
// card whose text no longer hashes to its ledger entry is unstamped, and an entry no card has is gone.
// `card-stamp.ts` writes the ledger from here; `card-ledger.test.ts` refuses a build with either.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { type CardLedger, type CardLedgerEntry, cardHash } from '../lib/card-changed.js';
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { mcpDoors } from './door-catalog.js';
import { REST_CARDS } from './rest-cards.js';

/** Every card, once: the MCP actions' (a twin's card among them), the orientation's and the REST modules'. */
export function everyCard(): CapabilityCard[] {
  const cards = [
    ...mcpDoors().flatMap((d) => (d.card ? [d.card] : [])),
    ...AFFORDANCE_CARDS,
    ...REST_CARDS,
  ];
  return [...new Map(cards.map((c) => [c.id, c])).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** What a card teaches, without its door, owner or date: the text its ledger hash is of. */
export const hashOf = ({ id: _id, owner: _owner, changed: _changed, ...text }: CapabilityCard) =>
  cardHash(text);

/** The cards whose text the ledger does not hold, and the ledger entries no card has any more. */
export function ledgerDrift(
  cards: readonly CapabilityCard[],
  ledger: CardLedger,
): { unstamped: string[]; gone: string[] } {
  const ids = new Set(cards.map((c) => c.id));
  return {
    unstamped: cards.filter((c) => ledger[c.id]?.hash !== hashOf(c)).map((c) => c.id),
    gone: Object.keys(ledger).filter((id) => !ids.has(id)),
  };
}

/** The ledger after a stamp: a card whose text changed takes `on` and `by`, the rest keep theirs. */
export function stampedLedger(
  cards: readonly CapabilityCard[],
  ledger: CardLedger,
  on: string,
  by: string,
): Record<string, CardLedgerEntry> {
  return Object.fromEntries(
    cards.map((c) => {
      const hash = hashOf(c);
      const held = ledger[c.id];
      return [c.id, held?.hash === hash ? held : { hash, on, by }];
    }),
  );
}
