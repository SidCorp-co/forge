// A card is replayed on its scenarios (ISS-1251 §1, §5): every scenario a card names is in the
// registry and every scenario in it is named by its card; each holds on its card as this build serves
// it, so a card or a map line changed so that a scenario no longer holds is red here, naming it; and
// a change to a card is adopted only where it improves the card (criterion 5). Criterion 11: the five
// bad turns ISS-1250 quotes fail their scenarios on the teaching the agent read when it made them and
// pass on this build's, and the good posts pass.
//
// @direct-test-of packages/core/src/mcp/card-scenarios.ts
// @direct-test-of packages/core/src/mcp/scenarios-room.ts
// @direct-test-of packages/core/src/mcp/scenarios-room-work.ts
// @direct-test-of packages/core/src/mcp/scenarios-delivery.ts
// @direct-test-of packages/core/src/mcp/scenarios-product.ts
// @direct-test-of packages/core/src/mcp/scenarios-requirements.ts
// @direct-test-of packages/core/src/mcp/scenarios-feedback.ts
// @direct-test-of packages/core/src/mcp/scenarios-release.ts
// @direct-test-of packages/core/src/lessons/scenario-replay.ts
// @direct-test-of packages/core/src/support/room-conduct.ts
// @direct-test-of packages/core/src/support/ops-prompt.ts
// @direct-test-when \bsituations\s*:|\bpractice\s*:|\bredFlag\s*:|\bscenarios\s*:

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { describe, expect, it } from 'vitest';
import {
  type CardScenario,
  type CardText,
  improves,
  replayChange,
  replayScenario,
  replayScenarios,
  teachingOf,
  withDelta,
} from '../lessons/index.js';
import { operationsBrief } from '../support/ops-prompt.js';
import { everyCard } from './card-ledger.js';
import { ISS_1250_TURNS } from './card-replay.js';
import BEFORE from './card-replay-before.json' with { type: 'json' };
import { CARD_SCENARIOS, cardTextOf, scenariosOf } from './card-scenarios.js';

const cards = everyCard();
const cardOf = (id: string): CapabilityCard => {
  const c = cards.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id} is served`);
  return c;
};
/** A card's own text, without the lines its audience reads beside it. */
const bare = ({ context: _context, ...card }: CardText): CardText => card;
const scenario = (name: string): CardScenario => {
  const s = CARD_SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
};

describe('every card’s scenarios are in the registry, and each holds on its card', () => {
  it('names each scenario once, at most 120 characters, on a card this build serves', () => {
    const names = CARD_SCENARIOS.map((s) => s.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    expect(names.filter((n) => n.length > 120)).toEqual([]);
    const ids = new Set(cards.map((c) => c.id));
    expect(CARD_SCENARIOS.filter((s) => !ids.has(s.card)).map((s) => s.card)).toEqual([]);
  });

  it('lists on each card exactly the scenarios the registry holds for it', () => {
    const drift = cards
      .map((c) => ({
        card: c.id,
        named: [...c.scenarios].sort(),
        held: scenariosOf(c.id)
          .map((s) => s.name)
          .sort(),
      }))
      .filter((d) => JSON.stringify(d.named) !== JSON.stringify(d.held));
    expect(drift, 'a card’s `scenarios` and the registry disagree').toEqual([]);
  });

  it('replays each scenario on its card as an agent reads it, and every one holds', () => {
    const failed = cards.flatMap((c) => {
      const text = cardTextOf(c);
      return replayScenarios(text.scenarios, teachingOf(text))
        .filter((r) => !r.passed)
        .map((r) => `${c.id} · ${r.scenario}: ${r.reason}`);
    });
    expect(failed).toEqual([]);
  });

  it('fails a scenario naming what the card stopped teaching (planted: the ask_master watch dropped)', () => {
    const text = cardTextOf(cardOf('support.ask_master'));
    const s = scenario('the owner told to set ePOD’s language in Forge’s settings himself');
    const dropped = {
      ...bare(text),
      situations: text.situations.map(({ watch: _w, ...rest }) => rest),
    };
    const run = replayScenario(s, teachingOf(dropped));
    expect(run.passed).toBe(false);
    expect(run.reason).toContain('never send anyone');
  });
});

describe('a change to a card is adopted only where it improves it (criterion 5)', () => {
  const card = cardTextOf(cardOf('support.ask_master'));
  // the card as it read without the line that holds an owner's instruction to the act
  const without = { ...bare(card), situations: card.situations.slice(1) };
  const LEAD = card.situations[0];
  if (!LEAD) throw new Error('support.ask_master holds no situation');

  it('refuses a worse change: an update that drops what a scenario needs regresses it', () => {
    const worse = withDelta(card, {
      field: 'situation',
      op: 'update',
      text: 'when someone instructs or rules → tell them who can do it',
      replaces: `${LEAD.when} → ${LEAD.do}`,
    });
    const verdict = replayChange(card.scenarios, teachingOf(bare(card)), teachingOf(bare(worse)));
    expect(verdict.regressed).toEqual([
      'the owner told to set ePOD’s language in Forge’s settings himself',
    ]);
    // refused even where the model's replay counts a past failure fixed
    expect(improves(verdict, true)).toBe(false);
  });

  it('adopts a better change: a delta that teaches what a failing scenario needs gains it', () => {
    const better = withDelta(without, {
      field: 'situation',
      op: 'add',
      text: `When ${LEAD.when} → ${LEAD.do}; never tell a thread what you or this room may not do, and never send anyone, the owner included, to a page, a setting or a button`,
    });
    const verdict = replayChange(card.scenarios, teachingOf(without), teachingOf(better));
    expect(verdict.regressed).toEqual([]);
    expect(verdict.gained).toEqual([
      'the owner told to set ePOD’s language in Forge’s settings himself',
    ]);
    expect(improves(verdict, false)).toBe(true);
  });

  it('adopts no change that improves nothing, however clean', () => {
    const same = replayChange(card.scenarios, teachingOf(card), teachingOf(card));
    expect(improves(same, false)).toBe(false);
    expect(improves(same, true)).toBe(true);
  });
});

/** The operations room's brief as this build renders it for Babo's role and Forge-Communicate's reach. */
const BRIEF_NOW = operationsBrief({
  role: {
    name: 'Babo',
    persona: '',
    grants: ['read', 'deliver', 'draft'],
  } as Parameters<typeof operationsBrief>[0]['role'],
  scope: 'all',
  reach: [
    { slug: 'epod', name: 'ePOD', issuePrefix: 'ISS' },
    { slug: 'forge', name: 'Forge', issuePrefix: 'ISS' },
  ] as unknown as Parameters<typeof operationsBrief>[0]['reach'],
});

/** What the agent reads now: a room act's card under the brief this build renders, any other card alone. */
const teachingNow = (s: CardScenario) => {
  const text = cardTextOf(cardOf(s.card));
  return s.card.startsWith('support.')
    ? `${BRIEF_NOW}\n${teachingOf(bare(text))}`
    : teachingOf(text);
};

describe('the ISS-1250 turns replayed on the teaching before and after (criterion 11)', () => {
  const runs = ISS_1250_TURNS.map((t) => {
    const s = scenario(t.scenario);
    return {
      at: t.at,
      card: s.card,
      bad: t.bad,
      before: replayScenario(s, t.before).passed,
      after: replayScenario(s, teachingNow(s)).passed,
    };
  });

  it('fails each of the five bad turns on the teaching its agent read when it made it', () => {
    expect(runs.filter((r) => r.bad).map((r) => [r.at, r.before])).toEqual([
      ['15/11 15:36', false],
      ['16/11 02:21', false],
      ['16/11 02:22', false],
      ['16/11 03:15', false],
      ['16/11 03:16', false],
    ]);
  });

  it('passes each of them, and the good posts, on this build’s cards and brief', () => {
    expect(runs.filter((r) => !r.after)).toEqual([]);
  });

  it('keeps the good posts passing on the teaching before as well', () => {
    expect(runs.filter((r) => !r.bad).map((r) => [r.at, r.before])).toEqual([
      ['16/11 02:18, 02:36, 02:53', true],
      ['16/11 03:14', true],
    ]);
  });

  it('reads the fixture as the releases that served the turns', () => {
    expect([BEFORE.dev685.release, BEFORE.dev690.release]).toEqual([
      '0.4.0-dev.685',
      '0.4.0-dev.690',
    ]);
    expect(BEFORE.dev685.bot).toContain(
      'say in the thread what the refusal says and who can do it',
    );
  });
});
