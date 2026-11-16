// A card's `changed` is read from the card ledger, never written by hand (ISS-1251): a card whose
// text no longer hashes to its ledger entry is red here, naming it and the command that stamps it.
// @direct-test-of packages/core/src/
// @direct-test-of packages/contracts/src/
// @direct-test-when \bsituations\s*:|\bpractice\s*:|\bpurpose\s*:|card-changes

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { describe, expect, it } from 'vitest';
import { CARD_LEDGER, changedOf } from '../lib/card-changed.js';
import { card } from '../prompt/index.js';
import { everyCard, hashOf, ledgerDrift, stampedLedger } from './card-ledger.js';

const BODY = {
  purpose: 'Records who a member is.',
  situations: [{ when: 'a stranger writes', do: 'read who they are' }],
  practice: ['Read first.'],
  audience: ['bot' as const],
  scenarios: [],
};
const served = (over: Partial<typeof BODY> = {}): CapabilityCard =>
  card('POST /api/memory', 'memory', { ...BODY, ...over });

describe("a card's changed is its ledger's, never written by hand", () => {
  it('holds every card this build serves at the text it was stamped at, and no card that is gone', () => {
    const drift = ledgerDrift(everyCard(), CARD_LEDGER);
    expect(
      drift,
      `cards changed without a stamp, or stamped and gone: run \`pnpm --filter @forge/core cards:stamp\` (${JSON.stringify(drift)})`,
    ).toEqual({ unstamped: [], gone: [] });
  });

  it('dates a card only while its text is the one stamped, so an edited card reads no date', () => {
    const was = served();
    const ledger = { [was.id]: { hash: hashOf(was), on: '2026-11-01', by: 'ISS-7' } };
    expect(changedOf(was.id, BODY, ledger)).toEqual({ on: '2026-11-01', by: 'ISS-7' });
    const edited = { ...BODY, practice: ['Read who they are first.'] };
    expect(changedOf(was.id, edited, ledger)).toBeUndefined();
    expect(ledgerDrift([served({ practice: edited.practice })], ledger).unstamped).toEqual([
      was.id,
    ]);
  });

  it('stamps only the cards whose text changed, and drops a card that is gone', () => {
    const kept = served();
    const ledger = {
      [kept.id]: { hash: hashOf(kept), on: '2026-11-01', by: 'ISS-7' },
      gone: { hash: 'x', on: '2026-11-01', by: 'ISS-7' },
    };
    const moved = card('POST /api/issues/:id/comments', 'comments', BODY);
    expect(ledgerDrift([kept, moved], ledger)).toEqual({ unstamped: [moved.id], gone: ['gone'] });
    expect(stampedLedger([kept, moved], ledger, '2026-11-16', 'ISS-1251')).toEqual({
      [kept.id]: ledger[kept.id],
      [moved.id]: { hash: hashOf(moved), on: '2026-11-16', by: 'ISS-1251' },
    });
  });

  it('refuses a date written on a card by name', () => {
    expect(() =>
      card('POST /api/memory', 'memory', {
        ...BODY,
        changed: { on: '2026-11-16', by: 'ISS-1251' },
      } as never),
    ).toThrow(/changed is derived, never written/);
  });
});
