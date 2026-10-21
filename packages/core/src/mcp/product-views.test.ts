import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { FeedbackForecast, ForecastPaused } from '@forge/contracts/forecast';
import type { RequirementState, RequirementSummary } from '@forge/contracts/requirements';
import { say } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { type FeedbackReads, feedbackProgress } from '../product-progress/index.js';
import { requirementProgress } from './requirement-views.js';

const asOf = '2026-10-16T09:00:00.000Z';
const says = {
  who: say('standing.who.you'),
  act: say('standing.act.none'),
  rule: say('standing.act.none'),
};
const nobody = { kind: 'none', who: 'Nobody', act: '', rule: '', ref: null, dueAt: null, says };

function standing(state: RequirementState, over: Partial<RequirementSummary['standing']> = {}) {
  return { standing: { state, waitingOn: nobody, tasks: [], ...over } } as unknown as Pick<
    RequirementSummary,
    'standing'
  >;
}

describe('a requirement’s progress says why it has no date', () => {
  it.each([
    ['draft', 'it is a draft, and issues are planned only after a person agrees it'],
    ['agreed', 'no issue carries it yet: it is agreed and waits to be broken down into issues'],
    ['deferred', 'it is deferred out of the current release, so no work is planned for it'],
    ['dropped', 'it was dropped, so nothing will be built'],
  ] as const)('%s with no issue', (state, why) => {
    const p = requirementProgress(standing(state), null, [], asOf);
    expect(p.eta).toEqual({ estimate: false, done: false, why });
    expect(p.work).toBeNull();
    expect(p.asOf).toBe(asOf);
  });

  it('names whom it waits on and its overdue breakdown task', () => {
    const p = requirementProgress(
      standing('agreed', {
        waitingOn: { ...nobody, kind: 'agent', who: 'Master', act: 'break it down' },
        tasks: [
          {
            kind: 'breakdown',
            owner: 'Project master',
            revision: 2,
            openedAt: asOf,
            dueAt: '2026-10-14T09:00:00.000Z',
            overdue: true,
          },
        ],
      } as never),
      null,
      [],
      asOf,
    );
    expect(p.waitingOn).toEqual([
      expect.objectContaining({ who: 'Master', act: 'break it down' }),
      expect.objectContaining({
        who: 'Project master',
        act: 'break it down into issues',
        at: '2026-10-14T09:00:00.000Z',
        late: true,
      }),
    ]);
  });
});

const triage: ForecastPaused = {
  label: 'forecast',
  asOf,
  kind: 'paused',
  who: 'Ana',
  act: 'triage it',
  reason: 'nobody has triaged it',
  says: { who: says.who, act: says.act, reason: says.rule },
  ref: null,
  since: asOf,
  late: null,
};

function item(key: string, over: Partial<FeedbackSummary> = {}): FeedbackSummary {
  return {
    key,
    title: key,
    phase: 'triaged',
    route: null,
    snoozed: null,
    waitingOn: nobody,
    ...over,
  } as unknown as FeedbackSummary;
}

function reads(items: FeedbackSummary[], forecasts: FeedbackForecast[] = []): FeedbackReads {
  return {
    asOf,
    forecasts: new Map(forecasts.map((f) => [f.key, f])),
    runs: new Map(),
    requirementIssues: new Map([['REQ-7', [{ key: 'ISS-9', status: 'in_progress' }]]]),
    items: new Map(items.map((s) => [s.key, s])),
  };
}

describe('a feedback item’s progress follows the work it became', () => {
  it('waits on its triage, with no date, while untriaged', () => {
    const fb = item('FB-1', { phase: 'new' });
    const p = feedbackProgress(fb, reads([fb], [{ key: 'FB-1', triage, delivery: null }]));
    expect(p.eta).toEqual({ estimate: false, done: false, why: 'it is not triaged yet' });
    expect(p.waitingOn).toEqual([expect.objectContaining({ who: 'Ana', act: 'triage it' })]);
  });

  it('reads the issues of the requirement it became as its work', () => {
    const fb = item('FB-2', {
      phase: 'planned',
      route: {
        route: 'new_requirement',
        carriers: [{ key: 'REQ-7', status: 'agreed' }],
        answer: null,
      },
    });
    const p = feedbackProgress(fb, reads([fb]));
    expect(p.work).toEqual({ total: 1, shipped: 0, awaitingRelease: 0, toDo: 1 });
    expect(p.eta).toMatchObject({
      estimate: false,
      why: 'it became REQ-7, which no issue carries yet',
    });
  });

  it('follows a duplicate to its root, and says so', () => {
    const root = item('FB-3', { phase: 'declined' });
    const dup = item('FB-4', {
      route: { route: 'duplicate', carriers: [{ key: 'FB-3', status: 'declined' }], answer: null },
    });
    const p = feedbackProgress(dup, reads([root, dup]));
    expect(p.eta).toEqual({
      estimate: false,
      done: false,
      why: 'it duplicates FB-3, and it was declined, so no work will ship for it',
    });
  });

  it('stops at a duplicate cycle rather than looping', () => {
    const a = item('FB-5', {
      route: { route: 'duplicate', carriers: [{ key: 'FB-6', status: null }], answer: null },
    });
    const b = item('FB-6', {
      route: { route: 'duplicate', carriers: [{ key: 'FB-5', status: null }], answer: null },
    });
    expect(feedbackProgress(a, reads([a, b])).eta.estimate).toBe(false);
  });
});
