// A capability card's scenarios and their replay (ISS-1251 §1, §5). A scenario is a real situation an
// agent met at the card's door, quoted from where it was recorded (a room's turn, a refusal, an issue's
// record): what the agent was handed, what the bad use did, what a good use does, and what the
// teaching must say for an agent reading it to take the good use. Replaying a scenario reads that
// teaching, the card's text with the lines its audience reads every turn beside it, so no model is
// called and a replay gives one answer: a change to a card, its teaching or a lesson folded into it
// is adopted only when no scenario that held before fails after it and it fixes something.

import type { CardDelta, CardText } from './ports.js';

/** One replayable case of a card, named as the card's `scenarios` lists it. */
export interface CardScenario {
  /** Its name on the card, at most 120 characters. */
  name: string;
  /** The card it replays. */
  card: string;
  /** Where the transcript is: the room, thread and time, or the record that quotes it. */
  source: string;
  /** What the agent was handed, quoted. */
  situation: string;
  /** What the bad use did, quoted where it was recorded; absent where the case is a good one kept. */
  bad?: string;
  /** What a good use of the door does there. */
  good: string;
  /** What the teaching must say for an agent reading it to take the good use: every pattern matches. */
  teaches: readonly RegExp[];
}

/** One scenario's replay: whether the teaching leads to the good use, and why. */
export interface ScenarioRun {
  scenario: string;
  passed: boolean;
  reason: string;
}

/** The text an agent reads in a card's situation: its audience's every-turn lines, then the card. */
export function teachingOf(card: Omit<CardText, 'id' | 'scenarios'>): string {
  return [
    ...(card.context ? [card.context] : []),
    ...card.situations.map((s) => `When ${s.when}: ${s.do}${s.watch ? `; watch: ${s.watch}` : ''}`),
    ...card.practice,
    ...(card.redFlag ? [`Red flag: ${card.redFlag}`] : []),
  ].join('\n');
}

/** Replay one scenario on a teaching: it passes where the teaching says each thing the good use needs. */
export function replayScenario(scenario: CardScenario, teaching: string): ScenarioRun {
  const missing = scenario.teaches.filter((p) => !p.test(teaching));
  if (missing.length === 0) {
    return { scenario: scenario.name, passed: true, reason: `taught: ${scenario.good}` };
  }
  return {
    scenario: scenario.name,
    passed: false,
    reason: `not taught ${missing.map((p) => p.source).join(' · ')}, so nothing turns ${scenario.bad ? `“${scenario.bad}”` : 'the agent'} to: ${scenario.good}`,
  };
}

export const replayScenarios = (
  scenarios: readonly CardScenario[],
  teaching: string,
): ScenarioRun[] => scenarios.map((s) => replayScenario(s, teaching));

/** The card as it reads with one delta: an add appends the line, an update replaces the line it names. */
export function withDelta(card: CardText, delta: CardDelta): CardText {
  const replaces = delta.op === 'update' ? delta.replaces : undefined;
  const swap = (line: string) => (replaces !== undefined && line === replaces ? delta.text : line);
  if (delta.field === 'redFlag') {
    return {
      ...card,
      redFlag: delta.op === 'add' || !card.redFlag ? delta.text : swap(card.redFlag),
    };
  }
  if (delta.field === 'bestPractice') {
    return {
      ...card,
      practice: delta.op === 'add' ? [...card.practice, delta.text] : card.practice.map(swap),
    };
  }
  const [when, ...rest] = delta.text.replace(/^when\s+/i, '').split(/\s*(?:→|->)\s*/);
  const line = { when: when ?? delta.text, do: rest.join(' → ') || delta.text };
  if (delta.op === 'add') return { ...card, situations: [...card.situations, line] };
  return {
    ...card,
    situations: card.situations.map((s) =>
      replaces !== undefined && [`${s.when} → ${s.do}`, s.when, s.do].includes(replaces) ? line : s,
    ),
  };
}

/** What a change did to a card's scenarios: those it broke and those it newly made hold. */
export interface ScenarioVerdict {
  before: ScenarioRun[];
  after: ScenarioRun[];
  /** Held before the change, fail after it: a change with any is not adopted. */
  regressed: string[];
  /** Failed before the change, hold after it. */
  gained: string[];
}

/** Replay a card's scenarios on its teaching as it reads now and as the change would leave it. */
export function replayChange(
  scenarios: readonly CardScenario[],
  before: string,
  after: string,
): ScenarioVerdict {
  const was = replayScenarios(scenarios, before);
  const now = replayScenarios(scenarios, after);
  const held = new Set(was.filter((r) => r.passed).map((r) => r.scenario));
  return {
    before: was,
    after: now,
    regressed: now.filter((r) => !r.passed && held.has(r.scenario)).map((r) => r.scenario),
    gained: now.filter((r) => r.passed && !held.has(r.scenario)).map((r) => r.scenario),
  };
}

/**
 * Whether a change improves its card: it breaks no scenario, and it fixes something, a scenario that
 * failed before or (`fixesElsewhere`) a past failure the replay of the lesson behind it showed fixed.
 */
export const improves = (v: ScenarioVerdict, fixesElsewhere: boolean): boolean =>
  v.regressed.length === 0 && (v.gained.length > 0 || fixesElsewhere);
