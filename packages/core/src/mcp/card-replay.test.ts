// A card change is replayed where it is served (ISS-1251 criteria 5 and 11): every card naming a
// scenario is replayed on the teaching its audience reads in this build, under a change named by the
// card's ledger issue and the teaching's hash; the ISS-1250 turns' results name what they did on the
// teaching their agent read and on this build's, so the card says it failed then and holds now.
//
// @direct-test-of packages/core/src/mcp/card-replay.ts
// A card restamp writes the ledger, and a card's text moves inside its strings, where no key
// line is touched: the two cards ISS-1385 and ISS-1388 restamped went red unselected (debt ea761022).
// @direct-test-of packages/core/src/lib/card-changes.json
// @direct-test-of packages/core/src/release-batch/cards.ts
// @direct-test-of packages/core/src/support/reply-card.ts

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { describe, expect, it } from 'vitest';
import { everyCard } from './card-ledger.js';
import { ISS_1250_TURNS, replayCards } from './card-replay.js';

const cards = everyCard();
const replays = replayCards(cards);
const runOf = (name: string) => {
  for (const r of replays) {
    const run = r.runs.find((x) => x.scenario === name);
    if (run) return { ...run, card: r.card, change: r.change };
  }
  throw new Error(`no replay of ${name}`);
};

describe('every card naming a scenario is replayed as served', () => {
  it('replays each card that names one, and no other, every scenario holding', () => {
    expect(replays.map((r) => r.card)).toEqual(
      cards.filter((c) => c.scenarios.length > 0).map((c) => c.id),
    );
    expect(replays.flatMap((r) => r.runs.filter((x) => !x.passed).map((x) => x.scenario))).toEqual(
      [],
    );
  });

  it('names the change by the card’s ledger issue and the teaching replayed', () => {
    const r = replays.find((x) => x.card === 'support.ask_master');
    expect(r?.change).toMatch(/^ISS-\d+ card change [0-9a-f]{12}$/);
  });

  it('names a new change once the card teaches something else (planted: a practice line added)', () => {
    const card = cards.find((c) => c.id === 'support.ask_master') as CapabilityCard;
    const [was] = replayCards([card]);
    const [now] = replayCards([{ ...card, practice: [...card.practice, 'A planted line.'] }]);
    expect(now?.change).not.toEqual(was?.change);
  });
});

describe('the ISS-1250 turns, replayed on the teaching before and on this build’s (criterion 11)', () => {
  it('records each bad turn as failed on its release’s teaching and holding on this build’s', () => {
    for (const t of ISS_1250_TURNS.filter((x) => x.bad)) {
      const run = runOf(t.scenario);
      expect(run.passed, t.at).toBe(true);
      expect(run.reason, t.at).toContain(`ISS-1250 ${t.at}: failed (not taught`);
      expect(run.reason, t.at).toContain(`on ${t.release}’s teaching; holds on this build’s`);
    }
  });

  it('records each good post as holding on both', () => {
    for (const t of ISS_1250_TURNS.filter((x) => !x.bad)) {
      const run = runOf(t.scenario);
      expect(run.passed, t.at).toBe(true);
      expect(run.reason, t.at).toContain(
        `ISS-1250 ${t.at}: held on ${t.release}’s teaching; holds`,
      );
    }
  });
});
