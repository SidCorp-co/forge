// A card change is replayed on its scenarios where the change is served (ISS-1251 §5, criteria 5 and
// 11). `card-scenarios.test.ts` replays every scenario on its card at build time, so a card that stops
// teaching what a scenario needs never lands; this replays them again in the core that serves the
// card, once per change to what the card's audience reads, and keeps each scenario's result on the
// card (`card_scenario_runs`), which the capabilities page reads. A card's change is named by the
// ledger's issue and a hash of the teaching it was replayed on, so an unchanged card is not replayed
// twice and a changed one is replayed on the next boot.
//
// The five bad room turns ISS-1250 quotes are replayed on two teachings: the one the agent read when
// it made them (`card-replay-before.json`, what dev.685 and dev.690 served) and this build's. Each
// result names both, so a card reads "fails on what dev.690 taught, holds on this build" rather than a
// bare pass.

import { createHash } from 'node:crypto';
import type { CapabilityCard } from '@forge/contracts/capability-cards';
import {
  type CardScenario,
  cardFreshness,
  recordScenarioRuns,
  replayScenario,
  type ScenarioRun,
  teachingOf,
} from '../lessons/index.js';
import { everyCard } from './card-ledger.js';
import BEFORE from './card-replay-before.json' with { type: 'json' };
import { cardTextOf } from './card-scenarios.js';

/** A recorded room turn and the teaching its agent read when it made it. */
export interface RecordedTurn {
  /** When it was posted, UTC, as ISS-1250 quotes it. */
  at: string;
  /** The scenario that replays it. */
  scenario: string;
  /** The release whose teaching the agent read, and that teaching. */
  release: string;
  before: string;
  /** A bad turn fails its scenario on the teaching before; a good post passes it on both. */
  bad: boolean;
}

/** The ISS-1250 epod thread's turns (Forge-Communicate, tmid 86aGqsokzYezYNdvF): five bad, two good. */
export const ISS_1250_TURNS: readonly RecordedTurn[] = [
  {
    at: '15/11 15:36',
    scenario: 'the room told it cannot read feedback, and that nobody is on',
    release: BEFORE.dev685.release,
    before: BEFORE.dev685.bot,
    bad: true,
  },
  {
    at: '16/11 02:21',
    scenario: 'a ruling read alone: “language per the setting” after the 02:18 post',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.bot,
    bad: true,
  },
  {
    at: '16/11 02:22',
    scenario: 'the owner told to set ePOD’s language in Forge’s settings himself',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.bot,
    bad: true,
  },
  {
    at: '16/11 03:15',
    scenario: 'a question the work settled, left for the owner to click',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.master,
    bad: true,
  },
  {
    at: '16/11 03:16',
    scenario: 'a person-facing link on the API host',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.bot,
    bad: true,
  },
  {
    at: '16/11 02:18, 02:36, 02:53',
    scenario: 'the ePOD release posts told in the asker’s thread once checked live',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.master,
    bad: false,
  },
  {
    at: '16/11 03:14',
    scenario: 'the Google-connect choice put to the owner: two options, a recommendation',
    release: BEFORE.dev690.release,
    before: BEFORE.dev690.master,
    bad: false,
  },
];

/** One card's replay as this build serves it: the change it is for, and each scenario's run. */
export interface CardReplay {
  card: string;
  change: string;
  runs: ScenarioRun[];
}

/** A run of a recorded turn's scenario says what it did on the teaching before and on this build's. */
function withTurn(
  scenario: CardScenario,
  run: ScenarioRun,
  turn: RecordedTurn | undefined,
): ScenarioRun {
  if (!turn) return run;
  const was = replayScenario(scenario, turn.before);
  const then = was.passed ? 'held' : `failed (${was.reason})`;
  return {
    ...run,
    reason: `ISS-1250 ${turn.at}: ${then} on ${turn.release}’s teaching; ${run.passed ? 'holds' : 'fails'} on this build’s: ${run.reason}`,
  };
}

/** Replay each card's scenarios on the teaching its audience reads in this build. */
export function replayCards(cards: readonly CapabilityCard[] = everyCard()): CardReplay[] {
  const turns = new Map(ISS_1250_TURNS.map((t) => [t.scenario, t]));
  return cards.flatMap((card) => {
    const text = cardTextOf(card);
    if (text.scenarios.length === 0) return [];
    const teaching = teachingOf(text);
    const hash = createHash('sha256')
      .update(teaching)
      .update(JSON.stringify(text.scenarios.map((s) => [s.name, s.teaches.map((p) => p.source)])))
      .digest('hex')
      .slice(0, 12);
    const change = `${card.changed?.by ?? 'unstamped'} card change ${hash}`;
    const runs = text.scenarios.map((s) =>
      withTurn(s, replayScenario(s, teaching), turns.get(s.name)),
    );
    return [{ card: card.id, change, runs }];
  });
}

/**
 * Replay every card whose teaching changed since its scenarios were last replayed, and keep each
 * result on the card. A card whose every scenario was last replayed for this same change is left as
 * it is. What was replayed, and the scenarios that failed.
 */
export async function replayChangedCards(
  cards: readonly CapabilityCard[] = everyCard(),
): Promise<{ cards: number; scenarios: number; failed: string[] }> {
  const replays = replayCards(cards);
  const held = new Map(
    (await cardFreshness(replays.map((r) => r.card))).map((f) => [
      f.cardId,
      new Map(f.scenarios.map((s) => [s.name, s.change])),
    ]),
  );
  let replayed = 0;
  let scenarios = 0;
  const failed: string[] = [];
  for (const r of replays) {
    const last = held.get(r.card);
    if (r.runs.every((run) => last?.get(run.scenario) === r.change)) continue;
    await recordScenarioRuns(r.card, r.change, r.runs);
    replayed += 1;
    scenarios += r.runs.length;
    failed.push(...r.runs.filter((x) => !x.passed).map((x) => `${r.card} · ${x.scenario}`));
  }
  return { cards: replayed, scenarios, failed };
}
