import type { OnboardingView } from '@forge/contracts/onboarding';
import { QUESTIONNAIRE_DUE_DAYS } from '@forge/contracts/onboarding';
import { saidDisagreements, say, verbatim } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { liveOf } from '../runs/standing-live.js';
import type { RunFacts, StandingContext } from '../runs/standing-types.js';
import { batchDue, type HintViewer, hintOf as hintOf_ } from './hint.js';

/** A reader holding onboarding.request (a member), and one who does not (a viewer). */
const HOLDER: HintViewer = { canRequest: true };
const VIEWER: HintViewer = { canRequest: false };

/** Every hint's words are the sentences it says (`saidDisagreements`); the reader holds onboarding.request unless named. */
const hintOf = (
  v: Parameters<typeof hintOf_>[0],
  ctx: Parameters<typeof hintOf_>[1],
  viewer: HintViewer = HOLDER,
) => {
  const h = hintOf_(v, ctx, viewer);
  expect(saidDisagreements(h)).toEqual([]);
  return h;
};

const T0 = new Date('2026-10-01T00:00:00Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  id: 'o1',
  projectId: 'p1',
  conversationId: 'c1',
  status: 'in_progress',
  roundsSent: 1,
  maxRounds: 3,
  startedBy: 'u1',
  startedAt: T0.toISOString(),
  reanalyzedAt: null,
  doneAt: null,
  designs: [],
  openBatch: null,
  job: null,
  sensitiveData: false,
  ...over,
});

const job = (over: Partial<NonNullable<OnboardingView['job']>> = {}) => ({
  id: 'j1',
  phase: 'analyse' as const,
  status: 'queued',
  queuedAt: T0.toISOString(),
  dispatchedAt: null,
  finishedAt: null,
  waitingOn: null,
  attempt: 1,
  endedWith: null,
  ...over,
});

describe('project-onboarding reanalyze: the dashboard hint offers a re-analysis', () => {
  it('makes re-analysis the action of a failed analysis, and names the role who asks for it (ISS-605)', () => {
    const h = hintOf(view({ status: 'failed', job: job({ status: 'failed' }) }), 'none', VIEWER);
    expect(h).toMatchObject({ tone: 'err', action: 'reanalyze', mayReanalyze: false });
    expect(h?.lead).toBe('Onboarding analysis failed.');
    expect(h?.text).toBe('Attempt 1 failed · Waits on: Member');
    expect(h?.text).not.toContain('onboarding.request');
    expect(h?.says.text.vars?.who).toEqual(
      say('standing.who.holderOf', { perm: 'onboarding.request' }),
    );
  });

  it('reads You to the reader who holds onboarding.request, and offers them the act (ISS-605)', () => {
    const h = hintOf(view({ status: 'failed', job: job({ status: 'failed' }) }), 'none', HOLDER);
    expect(h).toMatchObject({ action: 'reanalyze', mayReanalyze: true });
    expect(h?.text).toBe('Attempt 1 failed · Waits on: You');
    expect(h?.says.text.vars?.who).toEqual(say('standing.who.you'));
  });

  it("names the attempt that failed, and leaves the runner's failure tag off the line (ISS-268, ISS-605)", () => {
    const h = hintOf(
      view({
        status: 'failed',
        job: job({ status: 'failed', attempt: 3, endedWith: 'the runner went offline' }),
      }),
      'none',
      VIEWER,
    );
    expect(h?.text).toBe('Attempt 3 failed · Waits on: Member');
    expect(h?.text).not.toContain('the runner went offline');
  });

  it('says a failure before done, and before every design approved hides the line (ISS-605)', () => {
    const approved = {
      workflowId: 'w1',
      flow: 'f',
      title: 'F',
      template: null,
      designStatus: 'approved',
      revision: 1,
      approvedRevision: 1,
      linkedItems: [],
      openQuestions: [],
    };
    const done = view({ doneAt: T0.toISOString(), designs: [approved] });
    expect(hintOf({ ...done, status: 'done' }, 'none')).toBeNull();
    const failed = hintOf(
      {
        ...done,
        status: 'failed',
        job: job({ phase: 'revise', status: 'failed', attempt: 10, endedWith: 'cc-startup-death' }),
      },
      'none',
      VIEWER,
    );
    expect(failed?.text).toBe('Attempt 10 failed · Waits on: Member');
  });

  it('names the re-analysis, not an answer, while a round still holds a question open (ISS-605)', () => {
    const batch = {
      id: 'b1',
      round: 1,
      open: 2,
      postedAt: T0.toISOString(),
      ...batchDue(T0, day(1)),
    };
    const h = hintOf(
      view({ status: 'failed', openBatch: batch, job: job({ status: 'failed' }) }),
      'none',
    );
    expect(h?.action).toBe('reanalyze');
    expect(h?.tone).toBe('err');
  });

  it('heads a live retry with its attempt number, and leaves a first attempt unnumbered', () => {
    const first = hintOf(view({ job: job({ status: 'queued' }) }), 'none')?.text ?? '';
    const third = hintOf(view({ job: job({ status: 'queued', attempt: 3 }) }), 'none')?.text ?? '';
    expect(first).not.toMatch(/^Attempt/);
    expect(third).toBe(`Attempt 3: ${first}`);
  });

  it('never offers it while a job of the onboarding is live (ONBOARDING_ALREADY_RUNNING)', () => {
    expect(hintOf(view({ job: job({ status: 'dispatched' }) }), 'none')?.mayReanalyze).toBe(false);
  });

  it('offers it beside an open batch and a done onboarding', () => {
    const open = {
      id: 'b1',
      round: 1,
      open: 2,
      postedAt: T0.toISOString(),
      ...batchDue(T0, day(1)),
    };
    expect(hintOf(view({ openBatch: open }), 'none')?.mayReanalyze).toBe(true);
    expect(hintOf(view({ status: 'done', doneAt: T0.toISOString() }), 'none')?.mayReanalyze).toBe(
      true,
    );
  });

  it('is not offered to a reader who does not hold onboarding.request, whom the ask would refuse', () => {
    expect(
      hintOf(view({ status: 'done', doneAt: T0.toISOString() }), 'none', VIEWER)?.mayReanalyze,
    ).toBe(false);
  });

  it("says an attempt that drew nothing without the runner's failure tag (ISS-605)", () => {
    const h = hintOf(
      view({ job: job({ status: 'failed', attempt: 2, endedWith: 'cc-startup-death' }) }),
      'none',
    );
    expect(h?.text).toBe('Attempt 2 drew nothing');
  });

  it('is not offered before an onboarding exists', () => {
    expect(hintOf(null, 'none')?.mayReanalyze).toBe(false);
  });
});

describe('project-onboarding checkout: a queued job names the run read model wait', () => {
  it('reads the wait the run read model gives, not a fixed sentence', () => {
    const h = hintOf(
      view({
        job: job({
          waitingOn: waitingOn('person', {
            who: say('standing.who.named', { name: 'A project writer' }),
            act: say('runs.act.bindCheckout'),
            rule: verbatim('r'),
          }),
        }),
      }),
      'none',
    );
    expect(h?.text).toBe(
      'Waits on A project writer to bind a checkout on the box; the project works meanwhile.',
    );
    expect(h?.tone).toBe('you');
  });

  it('says it is queued, never that it waits on a checkout, when nothing waits', () => {
    expect(hintOf(view({ job: job() }), 'none')?.text).not.toContain('checkout');
  });

  it('turns a queued job whose every box is bound with no checkout into a person wait', () => {
    const facts = {
      run: { status: 'running', startedAt: T0, updatedAt: T0, pauseReason: null },
      issue: null,
      session: null,
      job: {
        id: 'j1',
        status: 'queued',
        heldBy: null,
        hold: null,
        retryAfterAt: null,
        queuedAt: T0,
      },
      ledger: null,
      question: null,
      approval: null,
      master: null,
    } as unknown as RunFacts;
    const ctx = {
      now: T0,
      viewer: null,
      holders: { write: ['Ana'], admin: ['Ada'], approve: [] },
      slots: null,
      queuedGates: new Map([['j1', 'checkout_unbound']]),
    } as unknown as StandingContext;
    const d = liveOf(facts, ctx);
    expect(d.state).toBe('waiting_person');
    if (d.waitingOn.kind === 'gate') throw new Error('checkout_unbound reads a person, not a gate');
    expect(d.waitingOn.act).toBe('bind a checkout on the box');
    expect(d.waitingOn.who).toBe('Ana');
    expect(d.waitingOn.rule).toContain('POOL_CHECKOUT_UNBOUND');
    const nobody = liveOf(facts, { ...ctx, holders: { write: [], admin: ['Ada'], approve: [] } });
    if (nobody.waitingOn.kind === 'gate') throw new Error('checkout_unbound reads a person');
    expect(nobody.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(nobody.waitingOn.act).toBe(
      'bind a checkout on the box: nobody holds project.write; grant it under Settings → Members',
    );
  });
});

describe('project-onboarding unanswered: one line, never a blocker', () => {
  it('is due QUESTIONNAIRE_DUE_DAYS after it was posted', () => {
    expect(batchDue(T0, day(1))).toEqual({
      dueAt: day(QUESTIONNAIRE_DUE_DAYS).toISOString(),
      overdue: false,
      waitingDays: 1,
    });
    expect(batchDue(T0, day(QUESTIONNAIRE_DUE_DAYS)).overdue).toBe(true);
  });

  it('raises the hint to attention past due and keeps its action a continue', () => {
    const open = {
      id: 'b1',
      round: 2,
      open: 3,
      postedAt: T0.toISOString(),
      ...batchDue(T0, day(9)),
    };
    const h = hintOf(view({ openBatch: open }), 'none');
    expect(h?.tone).toBe('attention');
    expect(h?.text).toContain('waiting 9 days');
    expect(h?.action).toBe('continue');
  });
});

// REQ-10 BC-6: a batch holding only assumptions asks the person nothing
describe('project-onboarding hint: a batch of assumptions only', () => {
  it('does not ask the person to answer when no question is open', () => {
    const assumed = {
      id: 'b1',
      round: 1,
      open: 0,
      postedAt: T0.toISOString(),
      ...batchDue(T0, day(1)),
    };
    const h = hintOf(view({ openBatch: assumed }), 'none');
    expect(h?.action).not.toBe('continue');
    expect(h?.tone).toBe('run');
  });
});

// F5: the banner's sentence reads as English for a master's wait and for a full machine
describe('project-onboarding banner: the run read model wait as a sentence', () => {
  const queued = {
    run: { status: 'running', startedAt: T0, updatedAt: T0, pauseReason: null },
    issue: null,
    session: null,
    job: { id: 'j1', status: 'queued', heldBy: null, hold: null, retryAfterAt: null, queuedAt: T0 },
    ledger: null,
    question: null,
    approval: null,
    master: null,
    deployLocks: [],
    lockRefusals: [],
    releaseAttempt: null,
  } as unknown as RunFacts;
  const textFor = (slots: { inUse: number; max: number } | null) => {
    const ctx = {
      now: T0,
      viewer: null,
      slots,
      queuedGates: new Map(),
    } as unknown as StandingContext;
    const d = liveOf(queued, ctx);
    return hintOf(view({ job: job({ waitingOn: d.waitingOn }) }), 'none')?.text;
  };

  it('waits on the master to dispatch it', () => {
    expect(textFor({ inUse: 0, max: 2 })).toBe(
      'Waits on Master to dispatch it; the project works meanwhile.',
    );
  });

  it('names a full machine as a state, not as an act', () => {
    expect(textFor({ inUse: 2, max: 2 })).toBe(
      'Waiting on Machine: no free slot (2 of 2 in use); the project works meanwhile.',
    );
  });
});
