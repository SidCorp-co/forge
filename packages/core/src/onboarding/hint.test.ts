import type { OnboardingView } from '@forge/contracts/onboarding';
import { QUESTIONNAIRE_DUE_DAYS } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { liveOf } from '../runs/standing-live.js';
import type { RunFacts, StandingContext } from '../runs/standing-types.js';
import { batchDue, hintOf } from './hint.js';

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
  ...over,
});

describe('project-onboarding reanalyze: the dashboard hint offers a re-analysis', () => {
  it('makes re-analysis the action of a failed analysis', () => {
    const h = hintOf(view({ job: job({ status: 'failed' }) }), 'none');
    expect(h?.action).toBe('reanalyze');
    expect(h?.mayReanalyze).toBe(true);
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

  it('is not offered before an onboarding exists', () => {
    expect(hintOf(null, 'none')?.mayReanalyze).toBe(false);
  });
});

describe('project-onboarding checkout: a queued job names the run read model wait', () => {
  it('reads the wait the run read model gives, not a fixed sentence', () => {
    const h = hintOf(
      view({
        job: job({
          waitingOn: {
            kind: 'person',
            who: 'A project writer',
            act: 'bind a checkout on the box',
            rule: 'r',
            ref: null,
            dueAt: null,
          },
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
      slots: null,
      queuedGates: new Map([['j1', 'checkout_unbound']]),
    } as unknown as StandingContext;
    const d = liveOf(facts, ctx);
    expect(d.state).toBe('waiting_person');
    if (d.waitingOn.kind === 'gate') throw new Error('checkout_unbound reads a person, not a gate');
    expect(d.waitingOn.act).toBe('bind a checkout on the box');
    expect(d.waitingOn.rule).toContain('POOL_CHECKOUT_UNBOUND');
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
