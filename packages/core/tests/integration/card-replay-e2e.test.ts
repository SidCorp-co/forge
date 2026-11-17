// A card change is replayed where it is served and its results reach the card (ISS-1251 criteria 5
// and 11). The boot's replay keeps each scenario's result on its card, which the capabilities page
// reads, so a card naming scenarios no longer reads "Not replayed"; the five ISS-1250 turns read
// failed on the teaching their agent read and holding on this build's; an unchanged card is not
// replayed twice, and one whose teaching changed is replayed again. Against real Postgres.
//
// @direct-test-of packages/core/src/mcp/card-replay.ts
// @direct-test-of packages/core/src/metrics/capabilities.ts

import { randomUUID } from 'node:crypto';
import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { describe, expect, it } from 'vitest';
import { cardFreshness } from '../../src/lessons/index.js';
import { everyCard } from '../../src/mcp/card-ledger.js';
import { ISS_1250_TURNS, replayChangedCards } from '../../src/mcp/card-replay.js';
import { readCapabilities } from '../../src/metrics/capabilities.js';

const cards = everyCard();
const named = cards.filter((c) => c.scenarios.length > 0);
const MOVE = 'POST /api/issues/:id/transition';
const PARKED = 'an issue parked on another issue’s landing: QUESTION_MERGE_IS_ORDERING';

describe('the boot replays each changed card and keeps the result on the card', () => {
  it('replays every card naming a scenario, each holding, and the capabilities page reads them', async () => {
    const first = await replayChangedCards(cards);
    expect(first.cards).toBe(named.length);
    expect(first.failed).toEqual([]);

    const view = await readCapabilities(randomUUID(), 30);
    const replayed = new Set(
      view.freshness.filter((f) => f.scenarios.length > 0).map((f) => f.card),
    );
    expect(named.filter((c) => !replayed.has(c.id)).map((c) => c.id)).toEqual([]);
    for (const c of named) {
      const row = view.freshness.find((f) => f.card === c.id);
      expect(row?.scenarios.map((s) => s.name).sort(), c.id).toEqual([...c.scenarios].sort());
      expect(
        row?.scenarios.every((s) => s.passed),
        c.id,
      ).toBe(true);
    }
  });

  it('reads the five bad ISS-1250 turns failed on their release’s teaching and holding now', async () => {
    await replayChangedCards(cards);
    const all = await cardFreshness();
    const runOf = (name: string) => all.flatMap((f) => f.scenarios).find((s) => s.name === name);
    for (const t of ISS_1250_TURNS) {
      const run = runOf(t.scenario);
      expect(run?.passed, t.at).toBe(true);
      expect(run?.reason, t.at).toContain(
        t.bad
          ? `ISS-1250 ${t.at}: failed (not taught`
          : `ISS-1250 ${t.at}: held on ${t.release}’s teaching`,
      );
    }
  });

  it('leaves an unchanged card alone and replays one whose teaching changed', async () => {
    await replayChangedCards(cards);
    const again = await replayChangedCards(cards);
    expect(again).toEqual({ cards: 0, scenarios: 0, failed: [] });

    const card = cards.find((c) => c.id === MOVE) as CapabilityCard;
    const [before] = await cardFreshness([MOVE]);
    // planted: the transition card stops teaching that an ordering is a `blocks` edge, never a park
    const dropped: CapabilityCard = {
      ...card,
      situations: [{ when: 'you move an issue', do: 'move it' }],
      practice: ['Move it.'],
    };
    const changed = await replayChangedCards([dropped]);
    expect(changed.cards).toBe(1);
    expect(changed.failed).toContain(`${MOVE} · ${PARKED}`);
    const [after] = await cardFreshness([MOVE]);
    const run = after?.scenarios.find((s) => s.name === PARKED);
    expect(run?.passed).toBe(false);
    expect(run?.reason).toContain('not taught');
    expect(run?.change).not.toEqual(before?.scenarios.find((s) => s.name === PARKED)?.change);
  });
});
