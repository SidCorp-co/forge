import type { OnboardingView } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { hintOf } from './read.js';
import {
  agentWriteRefusal,
  closeRefusal,
  dataFlowRefusal,
  designUnknownRefusals,
  doneRefusal,
  personActRefusal,
  reanalyzeRefusal,
  settlesPhaseJob,
  startRefusal,
} from './rules.js';

const job = { id: 'j1', status: 'running', queuedAt: new Date(0), dispatchedAt: new Date(1000) };

describe('onboarding guards (project-onboarding rule may-start)', () => {
  it('ONBOARDING_ALREADY_RUNNING names the running job and when it started', () => {
    expect(startRefusal(null, null)).toBeNull();
    const r = startRefusal(null, job);
    expect(r?.code).toBe('ONBOARDING_ALREADY_RUNNING');
    expect(r?.detail).toContain('j1');
    expect(r?.detail).toContain(new Date(1000).toISOString());
    expect(reanalyzeRefusal({ id: 'o1' }, job)?.code).toBe('ONBOARDING_ALREADY_RUNNING');
  });

  it('ONBOARDING_ALREADY_STARTED: a fresh read is a re-analysis; ONBOARDING_NOT_STARTED: nothing to re-analyse', () => {
    expect(startRefusal({ id: 'o1', status: 'done' }, null)?.code).toBe(
      'ONBOARDING_ALREADY_STARTED',
    );
    expect(reanalyzeRefusal(null, null)?.code).toBe('ONBOARDING_NOT_STARTED');
    expect(reanalyzeRefusal({ id: 'o1' }, null)).toBeNull();
  });

  it('ONBOARDING_DONE until a re-analysis reopens it', () => {
    expect(doneRefusal('waiting_on_you')).toBeNull();
    expect(doneRefusal('done')?.code).toBe('ONBOARDING_DONE');
  });

  it('ONBOARDING_ACT_FORBIDDEN: start and re-analysis are a person’s acts; ONBOARDING_WRITE_FORBIDDEN: updates are the agent’s', () => {
    expect(
      personActRefusal({ userId: 'u', agency: 'human', role: 'member' }, 'p', 'starting'),
    ).toBeNull();
    expect(
      personActRefusal({ userId: 'a', agency: 'agent', role: 'admin' }, 'p', 'starting')?.code,
    ).toBe('ONBOARDING_ACT_FORBIDDEN');
    expect(agentWriteRefusal({ userId: 'a', agency: 'agent', role: 'member' }, 'p')).toBeNull();
    expect(agentWriteRefusal({ userId: 'u', agency: 'human', role: 'admin' }, 'p')?.code).toBe(
      'ONBOARDING_WRITE_FORBIDDEN',
    );
    expect(closeRefusal({ userId: 'u', agency: 'human', role: 'member' }, 'p')).toBeNull();
    expect(closeRefusal({ userId: 'a', agency: 'agent', role: 'member' }, 'p')).toBeNull();
    expect(closeRefusal({ userId: 'u', agency: 'human', role: 'viewer' }, 'p')?.code).toBe(
      'ONBOARDING_ACT_FORBIDDEN',
    );
  });

  it('ONBOARDING_DESIGN_UNKNOWN and ONBOARDING_DATA_FLOW_MISSING (mandatory on sensitive data)', () => {
    expect(designUnknownRefusals(['w9'])[0]?.code).toBe('ONBOARDING_DESIGN_UNKNOWN');
    expect(dataFlowRefusal(false, ['system-context'])).toBeNull();
    expect(dataFlowRefusal(true, ['system-context', 'data-flow'])).toBeNull();
    expect(dataFlowRefusal(true, ['system-context', null])?.code).toBe(
      'ONBOARDING_DATA_FLOW_MISSING',
    );
  });
});

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  id: 'o1',
  projectId: 'p',
  conversationId: 'c',
  status: 'waiting_on_you',
  roundsSent: 1,
  maxRounds: 3,
  startedBy: 'u',
  startedAt: new Date(0).toISOString(),
  reanalyzedAt: null,
  doneAt: null,
  designs: [],
  openBatch: null,
  job: null,
  sensitiveData: false,
  ...over,
});
const design = (status: string) => ({
  workflowId: status,
  flow: status,
  title: status,
  template: 'system-context',
  designStatus: status,
  revision: 1,
  approvedRevision: null,
});

describe('the dashboard hint (non-blocking, derived)', () => {
  it('no onboarding: the hint reads the system-context design, never claiming none when one exists', () => {
    expect(hintOf(null)).toMatchObject({ lead: 'No system context yet.', action: 'start' });
    expect(hintOf(null, new Date(), 'none')).toMatchObject({ lead: 'No system context yet.' });
    expect(hintOf(null, new Date(), 'unapproved')).toMatchObject({
      lead: 'System context not approved yet.',
      action: 'start',
    });
    expect(hintOf(null, new Date(), 'approved')).toBeNull();
  });

  it('a queued job waits on a runner checkout; a running one says so', () => {
    const queued = hintOf(
      view({
        status: 'in_progress',
        job: {
          id: 'j',
          phase: 'analyse',
          status: 'queued',
          queuedAt: '',
          dispatchedAt: null,
          finishedAt: null,
        },
      }),
    );
    expect(queued?.text).toContain('waits on a runner checkout');
  });

  it('round 1 waiting names the drafted designs and open questions; a follow-up says so; late is attention', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const r1 = hintOf(
      view({
        designs: [design('proposed')],
        openBatch: { id: 'b', round: 1, open: 7, postedAt: now.toISOString() },
      }),
      now,
    );
    expect(r1?.text).toBe('The agent read the code and drafted 1 design · Open questions 7');
    const r2 = hintOf(
      view({ openBatch: { id: 'b', round: 2, open: 3, postedAt: now.toISOString() } }),
      now,
    );
    expect(r2).toMatchObject({ lead: 'Onboarding:', actionLabel: 'Continue onboarding' });
    const late = hintOf(
      view({ openBatch: { id: 'b', round: 1, open: 1, postedAt: '2026-09-20T00:00:00Z' } }),
      now,
    );
    expect(late?.tone).toBe('attention');
  });

  it('done: designs wait on approval; every design approved: the hint leaves the dashboard', () => {
    expect(
      hintOf(view({ status: 'done', designs: [design('proposed'), design('approved')] }))?.text,
    ).toBe('1 design wait on your approval.');
    expect(hintOf(view({ status: 'done', designs: [design('approved')] }))).toBeNull();
  });
});

describe("a phase job is settled by the agent's last act", () => {
  it('settles a job still out with a runner when the agent posts its last act, and nothing else', () => {
    expect(settlesPhaseJob('agent', 'dispatched')).toBe(true);
    expect(settlesPhaseJob('agent', 'running')).toBe(true);
    expect(settlesPhaseJob('human', 'running')).toBe(false);
    expect(settlesPhaseJob('agent', 'failed')).toBe(false);
    expect(settlesPhaseJob('agent', 'queued')).toBe(false);
    expect(settlesPhaseJob('agent', null)).toBe(false);
  });
});
