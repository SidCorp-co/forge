// When each capability card's text last changed (ISS-1251), never written by hand: the ledger beside
// this file holds, per card, a hash of the text it was stamped at, the day and the issue. A card is
// served with its `changed` only while its text still hashes to the ledger's, so a card edited and not
// stamped reads no date rather than an old one, and `mcp/card-ledger.test.ts` goes red naming it.
// `pnpm --filter @forge/core cards:stamp` writes the ledger from the cards (`mcp/card-stamp.ts`).

import { createHash } from 'node:crypto';
import type {
  CapabilityCard,
  CapabilityCardFields,
  CardChanged,
} from '@forge/contracts/capability-cards';
import ledger from './card-changes.json' with { type: 'json' };

export interface CardLedgerEntry extends CardChanged {
  hash: string;
}
export type CardLedger = Readonly<Record<string, CardLedgerEntry>>;

export const CARD_LEDGER: CardLedger = ledger;

/** The JSON of `value` with every object's keys in order, so one text has one hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hash of what a card says: everything a reader is taught, not when it was stamped. */
export function cardHash(body: Omit<CapabilityCardFields, 'changed'>): string {
  const { changed: _derived, ...text } = body as CapabilityCardFields;
  return createHash('sha256').update(canonical(text)).digest('hex').slice(0, 16);
}

/** The card's `changed` while the ledger's hash is this text's; absent otherwise. */
export function changedOf(
  id: string,
  body: Omit<CapabilityCardFields, 'changed'>,
  from: CardLedger = CARD_LEDGER,
): CardChanged | undefined {
  const entry = from[id];
  return entry && entry.hash === cardHash(body) ? { on: entry.on, by: entry.by } : undefined;
}

/** A card as served: its door, its owner, what it says and, from the ledger, when that last changed. */
export function servedCard(id: string, owner: string, body: CapabilityCardFields): CapabilityCard {
  const { changed: _derived, ...text } = body;
  const changed = changedOf(id, text);
  return { id, owner, ...text, ...(changed ? { changed } : {}) };
}
