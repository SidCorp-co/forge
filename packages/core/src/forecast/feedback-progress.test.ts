// The user's rule for feedback: its page always says whether work on it is running, and when it is
// done, or plainly why no date can be given. These are the two decisions behind that answer.
import type { FeedbackSummary } from '@forge/contracts/feedback';
import type {
  DeliveryForecast,
  FeedbackForecast,
  Forecast,
  ForecastPaused,
  ForecastWaitSays,
} from '@forge/contracts/forecast';
import { say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { noWorkLine } from './feedback.js';
import { estimateOf, workStateOf } from './feedback-progress.js';

const asOf = '2026-10-16T09:00:00.000Z';
const stamp = { label: 'forecast' as const, asOf };
const says: ForecastWaitSays = {
  who: say('standing.who.you'),
  act: say('standing.act.triage', { what: 'FB-1' }),
  reason: say('requirements.rule.moving'),
};
const paused: ForecastPaused = {
  ...stamp,
  kind: 'paused',
  who: 'You',
  act: 'triage it',
  reason: 'r',
  says,
  ref: null,
  since: null,
  late: null,
};

type Item = Pick<FeedbackSummary, 'route' | 'phase' | 'snoozed' | 'waitingOn' | 'times'>;
// the item's own standing says what the forecast's wait said, so every wait below reads `says`
const item = (over: Partial<Item> = {}): Item => ({
  route: { route: 'issue', carriers: [{ key: 'ISS-1', status: 'open' }], answer: null },
  phase: 'planned',
  snoozed: null,
  waitingOn: waitingOn('you', { who: says.who, act: says.act, rule: says.reason }),
  times: {
    actClass: 'person_decide',
    since: asOf,
    dueAt: null,
    stuck: null,
    carriedBy: null,
    basis: 'waiting|person',
  },
  ...over,
});
const line = (over: Partial<FeedbackForecast> = {}): FeedbackForecast => ({
  key: 'FB-1',
  triage: null,
  delivery: null,
  ...over,
});
const delivery = (landing: Forecast, over: Partial<DeliveryForecast> = {}): DeliveryForecast => ({
  ...stamp,
  landing,
  release: null,
  inHands: null,
  shipped: null,
  ...over,
});
const estimate = (i: Item, l: FeedbackForecast) => estimateOf(i, i, l);

describe('is work on it running', () => {
  it('reads running while any issue is in progress, whatever the others read', () => {
    expect(workStateOf(['needs_info', 'in_progress', 'open'])).toEqual({
      state: 'running',
      running: 1,
      total: 3,
    });
  });

  it('reads the next state down the ladder when none runs', () => {
    expect(workStateOf(['on_hold', 'open']).state).toBe('parked');
    expect(workStateOf(['approved', 'draft']).state).toBe('queued');
    expect(workStateOf(['draft']).state).toBe('drafted');
    expect(workStateOf(['awaiting_release', 'closed']).state).toBe('landed');
    expect(workStateOf(['closed', 'closed']).state).toBe('shipped');
  });

  it('tells no issues apart from every issue dropped, and counts a dropped one nowhere', () => {
    expect(workStateOf([])).toEqual({ state: 'no_issues', running: 0, total: 0 });
    expect(workStateOf(['dropped'])).toEqual({ state: 'ended', running: 0, total: 0 });
    expect(workStateOf(['dropped', 'in_progress']).total).toBe(1);
  });
});

describe('when it is done, or why no date is given', () => {
  it('names who triages an untriaged item and gives no date', () => {
    expect(estimate(item({ route: null, phase: 'new' }), line({ triage: paused }))).toEqual({
      kind: 'none',
      reason: 'untriaged',
      waits: says,
      history: null,
      until: null,
    });
  });

  it('says until when a snoozed item is parked', () => {
    const snoozed = item({ route: null, phase: 'new', snoozed: { until: asOf, reason: null } });
    expect(estimate(snoozed, line())).toMatchObject({ reason: 'snoozed', until: asOf });
  });

  it('says no work ships for an answer, a revision or a decline, and no issues for an empty route', () => {
    const answered = item({ route: { route: 'answer', carriers: [], answer: 'a' } });
    expect(estimate(answered, line())).toMatchObject({ reason: 'no_work' });
    const declined = item({ phase: 'declined', route: null });
    expect(estimate(declined, line())).toMatchObject({ reason: 'no_work' });
    const empty = item({ route: { route: 'new_requirement', carriers: [], answer: null } });
    expect(estimate(empty, line())).toMatchObject({ reason: 'no_issues' });
  });

  it('gives the dates where the line holds a range, and the ship where it shipped', () => {
    const span = { p50At: asOf, p85At: asOf, p50Minutes: 60, p85Minutes: 90 };
    const landed: Forecast = { ...stamp, kind: 'landed', landedAt: asOf };
    expect(estimate(item(), line({ delivery: delivery(landed, { inHands: span }) }))).toEqual({
      kind: 'dated',
      p50At: asOf,
      p85At: asOf,
      of: 'hands',
    });
    const shipped = delivery(landed, { shipped: { version: '1.2.0', at: asOf } });
    expect(estimate(item(), line({ delivery: shipped }))).toEqual({
      kind: 'shipped',
      version: '1.2.0',
      at: asOf,
    });
  });

  it('names the wait, the short history, the end or the release owed where the line holds no date', () => {
    expect(estimate(item(), line({ delivery: delivery(paused) }))).toMatchObject({
      reason: 'waits',
      waits: says,
    });
    const thin: Forecast = { ...stamp, kind: 'not_enough_history', n: 3, floor: 10 };
    expect(estimate(item(), line({ delivery: delivery(thin) }))).toMatchObject({
      reason: 'history',
      history: { n: 3, floor: 10 },
    });
    const ended: Forecast = { ...stamp, kind: 'ended', status: 'dropped' };
    expect(estimate(item(), line({ delivery: delivery(ended) }))).toMatchObject({
      reason: 'ended',
    });
    const landed: Forecast = { ...stamp, kind: 'landed', landedAt: asOf };
    const cut = delivery(landed, {
      release: {
        kind: 'person',
        mode: 'manual',
        who: 'You',
        act: 'cut 1.2.0',
        reason: 'r',
        says,
        version: '1.2.0',
        holders: [],
      },
    });
    expect(estimate(item(), line({ delivery: cut }))).toMatchObject({
      reason: 'release_waits',
      waits: says,
    });
    const lagless = delivery(landed, { release: { kind: 'not_enough_history', n: 1, floor: 5 } });
    expect(estimate(item(), line({ delivery: lagless }))).toMatchObject({
      reason: 'release_history',
      history: { n: 1, floor: 5 },
    });
  });

  it('refuses by name a line that holds neither a date nor a named wait', () => {
    const landed: Forecast = { ...stamp, kind: 'landed', landedAt: asOf };
    expect(() => estimate(item(), line({ delivery: delivery(landed) }))).toThrow(/FB-1/);
  });

  it('reads a duplicate by its root’s route', () => {
    const dup = item({ route: { route: 'duplicate', carriers: [], answer: null } });
    const root = item({ route: { route: 'answer', carriers: [], answer: 'a' } });
    expect(estimateOf(dup, root, line())).toMatchObject({ reason: 'no_work' });
  });
});

// REQ-48 BC-9: FB-74's body said "You to take on or drop" off its draft carrier's forecast while its
// banner said "ship"; the body now names the item's own standing, so the two say one thing
describe("FB-74's shape: the body reads the item's own standing", () => {
  const draftCarrier = item({
    phase: 'triaged',
    waitingOn: waitingOn('agent', {
      who: say('standing.who.projectMaster'),
      act: say('standing.act.takeOn', { key: 'ISS-284' }),
      rule: say('feedback.rule.draftCarrier', { key: 'ISS-284' }),
    }),
    times: {
      actClass: 'master_take',
      since: asOf,
      dueAt: null,
      stuck: {
        code: 'draft_carrier',
        since: asOf,
        reason: 'ISS-284 is a draft, and nothing takes a draft on by itself.',
        via: 'ISS-284',
        says: { reason: say('standing.stuck.draftCarrier', { key: 'ISS-284' }) },
      },
      carriedBy: null,
      basis: 'stuck|agent',
    },
  });

  it('names whom the standing waits on and why it is stuck, never the carrier forecast’s own wait', () => {
    const e = estimate(draftCarrier, line({ delivery: delivery(paused) }));
    expect(e).toMatchObject({ kind: 'none', reason: 'waits' });
    expect(e.kind === 'none' && e.waits).toEqual({
      who: say('standing.who.projectMaster'),
      act: say('standing.act.takeOn', { key: 'ISS-284' }),
      reason: say('standing.stuck.draftCarrier', { key: 'ISS-284' }),
    });
  });
});

// FB-89 was declined and still read At risk: the decline keeps its route, and its carriers' forecast
// ran on past p85
describe("FB-89's shape: a declined item", () => {
  it('has no forecast line to be late on, whatever route it kept', () => {
    expect(noWorkLine({ key: 'FB-89', phase: 'declined' })).toEqual({
      key: 'FB-89',
      triage: null,
      delivery: null,
    });
    expect(noWorkLine({ key: 'FB-90', phase: 'planned' })).toBeNull();
  });
});
