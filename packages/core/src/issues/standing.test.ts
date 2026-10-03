import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput, toneOf, wavesOf } from './standing.js';

const NOW = new Date('2026-10-04T10:00:00Z');

const base = (over: Partial<IssueStandingInput> = {}): IssueStandingInput => ({
  status: 'open',
  waitingKind: null,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: new Date('2026-10-04T09:00:00Z'),
  releaseApproval: false,
  viewer: { userId: 'u1', canWrite: true },
  now: NOW,
  ...over,
});

const live = { holder: 'run-4', verdict: 'live' as const, expiresAt: '2026-10-04T10:30:00Z' };
const edge = (status: IssueStandingInput['status'], key = 'ISS-9') => ({
  id: key,
  key,
  title: 't',
  status,
});

describe('whose turn an issue is', () => {
  it('closed and dropped are done, waiting on nobody', () => {
    for (const status of ['closed', 'dropped'] as const) {
      const s = deriveIssueStanding(base({ status }));
      expect(s.attentionGroup).toBe('done');
      expect(s.waitingOn.kind).toBe('none');
      expect(s.wave).toBeNull();
    }
  });

  it('on_hold is paused and a person resumes it', () => {
    const s = deriveIssueStanding(base({ status: 'on_hold' }));
    expect(s.attentionGroup).toBe('paused');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: 'resume it' });
  });

  it('needs_info waits on the viewer, worded by its waiting kind', () => {
    const s = deriveIssueStanding(base({ status: 'needs_info', waitingKind: 'needs_decision' }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'make a decision' });
  });

  it('a reader who cannot write sees a person owed, not themselves', () => {
    const s = deriveIssueStanding(
      base({ status: 'needs_info', viewer: { userId: 'u2', canWrite: false } }),
    );
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'A project writer' });
  });

  it('an open human question at a working status needs a person even while a run holds it', () => {
    const s = deriveIssueStanding(base({ status: 'in_progress', lease: live, owesAnswer: true }));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn.act).toBe('answer a question');
  });

  it('a draft needs a person to take it on or drop it', () => {
    expect(deriveIssueStanding(base({ status: 'draft' })).waitingOn.act).toBe('take on or drop');
  });

  it('awaiting_release needs a person only where releases need approval', () => {
    const gated = deriveIssueStanding(base({ status: 'awaiting_release', releaseApproval: true }));
    expect(gated.attentionGroup).toBe('needs_you');
    expect(gated.tone).toBe('you');
    const free = deriveIssueStanding(base({ status: 'awaiting_release', releaseApproval: false }));
    expect(free.attentionGroup).toBe('queued');
    expect(free.tone).toBe('ready');
    expect(free.waitingOn.kind).toBe('release');
  });

  it('a live lease is moving, naming the step and how long it has run', () => {
    const s = deriveIssueStanding(
      base({
        status: 'in_progress',
        lease: live,
        step: 'test',
        stepStartedAt: new Date('2026-10-04T09:48:00Z'),
      }),
    );
    expect(s.attentionGroup).toBe('moving');
    expect(s.waitingOn).toMatchObject({ kind: 'run', who: 'Run', act: 'Test · 12 min' });
  });

  it('an expired lease holds nothing: in_progress with no holder is stuck', () => {
    const s = deriveIssueStanding(
      base({ status: 'in_progress', lease: { ...live, verdict: 'expired' } }),
    );
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn.who).toBe('No holder');
  });

  it('a live unsettled blocker makes an open issue stuck on that blocker', () => {
    const s = deriveIssueStanding(base({ blockedBy: [edge('in_progress', 'ISS-1402')] }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({
      kind: 'issue',
      who: 'ISS-1402',
      act: 'running',
      ref: 'ISS-1402',
    });
    expect(s.blockedBy.map((b) => b.key)).toEqual(['ISS-1402']);
  });

  it('a settled or closed blocker holds nothing back and is not listed', () => {
    for (const status of ['awaiting_release', 'closed', 'dropped'] as const) {
      const s = deriveIssueStanding(base({ blockedBy: [edge(status)] }));
      expect(s.attentionGroup).toBe('queued');
      expect(s.blockedBy).toEqual([]);
    }
  });

  it('reopen is stuck on the master; open and approved are queued for one', () => {
    expect(deriveIssueStanding(base({ status: 'reopen' })).waitingOn).toMatchObject({
      kind: 'master',
      act: 're-run after reopen',
    });
    expect(deriveIssueStanding(base({ status: 'reopen' })).attentionGroup).toBe('stuck');
    expect(deriveIssueStanding(base({ status: 'open' })).waitingOn.act).toBe('free slot');
    expect(deriveIssueStanding(base({ status: 'approved' })).waitingOn.act).toBe('build next');
  });

  it('a done issue blocks nothing', () => {
    expect(deriveIssueStanding(base({ status: 'closed', blocks: [edge('open')] })).blocks).toEqual(
      [],
    );
  });
});

describe('the status tone', () => {
  it('is the legend tone, with awaiting_release amber only under release approval', () => {
    expect(toneOf('in_progress', false)).toBe('run');
    expect(toneOf('reopen', false)).toBe('err');
    expect(toneOf('awaiting_release', true)).toBe('you');
    expect(toneOf('awaiting_release', false)).toBe('ready');
  });
});

describe('waves', () => {
  it('layers open issues by their deepest open blocker', () => {
    const w = wavesOf([
      { id: 'a', status: 'needs_info', blockedBy: [] },
      { id: 'b', status: 'in_progress', blockedBy: [] },
      { id: 'c', status: 'open', blockedBy: ['a'] },
      { id: 'd', status: 'open', blockedBy: ['b', 'c'] },
    ]);
    expect(Object.fromEntries(w)).toEqual({ a: 0, b: 0, c: 1, d: 2 });
  });

  it('a settled blocker holds nothing back', () => {
    const w = wavesOf([
      { id: 'a', status: 'awaiting_release', blockedBy: [] },
      { id: 'b', status: 'open', blockedBy: ['a'] },
    ]);
    expect(w.get('b')).toBe(0);
    expect(w.has('a')).toBe(false);
  });

  it('a cycle has no wave rather than a guessed one', () => {
    const w = wavesOf([
      { id: 'a', status: 'open', blockedBy: ['b'] },
      { id: 'b', status: 'open', blockedBy: ['a'] },
      { id: 'c', status: 'open', blockedBy: ['a'] },
    ]);
    expect(w.get('a')).toBeNull();
    expect(w.get('b')).toBeNull();
    expect(w.get('c')).toBeNull();
  });
});
