import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput, wavesOf } from './standing.js';

const base = (over: Partial<IssueStandingInput> = {}): IssueStandingInput => ({
  status: 'open',
  waitingKind: null,
  merged: false,
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
  now: new Date('2026-10-04T10:00:00Z'),
  ...over,
});

const HOLD = 'design hop-access-decision rev 5 is not approved';
const blocker = (status: IssueStandingInput['status'], designHold: string | null) => ({
  id: 'b',
  key: 'ISS-64',
  title: 'access decision',
  status,
  merged: false,
  step: null,
  designHold,
});

describe('a blocker that delivers a design (FB-57)', () => {
  it('holds its dependent at awaiting_release while the revision it delivers is not approved', () => {
    const s = deriveIssueStanding(base({ blockedBy: [blocker('awaiting_release', HOLD)] }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'issue', who: 'ISS-64', act: 'design approval' });
    expect(s.waitingOn.rule).toContain(HOLD);
    expect(s.blockedBy.map((b) => b.key)).toEqual(['ISS-64']);
  });

  it('holds it at closed too: the issue moving on does not settle the edge', () => {
    const s = deriveIssueStanding(base({ blockedBy: [blocker('closed', HOLD)] }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.blockedBy.map((b) => b.key)).toEqual(['ISS-64']);
  });

  it('planted red: a settled blocker with its revision approved releases the dependent', () => {
    const s = deriveIssueStanding(base({ blockedBy: [blocker('awaiting_release', null)] }));
    expect(s.attentionGroup).toBe('queued');
    expect(s.blockedBy).toEqual([]);
  });

  it('a dropped blocker holds nothing, whatever its design', () => {
    expect(deriveIssueStanding(base({ blockedBy: [blocker('dropped', HOLD)] })).blockedBy).toEqual(
      [],
    );
  });

  it('names its running work, not the design, while the blocker is still in progress', () => {
    const s = deriveIssueStanding(base({ blockedBy: [blocker('in_progress', HOLD)] }));
    expect(s.waitingOn.act).toBe('running');
  });

  it('a settled issue still owed a design approval keeps listing what it blocks', () => {
    const dependent = {
      id: 'd',
      key: 'ISS-33',
      title: 'identity',
      status: 'open' as const,
      merged: false,
      step: null,
    };
    const s = deriveIssueStanding(
      base({ status: 'awaiting_release', designHold: HOLD, blocks: [dependent] }),
    );
    expect(s.blocks.map((b) => b.key)).toEqual(['ISS-33']);
    expect(
      deriveIssueStanding(base({ status: 'awaiting_release', blocks: [dependent] })).blocks,
    ).toEqual([]);
  });

  it('puts the dependent a wave after a design-held blocker, and in wave 0 once approved', () => {
    const held = wavesOf([
      { id: 'a', status: 'awaiting_release', designHeld: true, blockedBy: [] },
      { id: 'b', status: 'open', blockedBy: ['a'] },
    ]);
    expect(held.get('b')).toBe(1);
    const approved = wavesOf([
      { id: 'a', status: 'awaiting_release', designHeld: false, blockedBy: [] },
      { id: 'b', status: 'open', blockedBy: ['a'] },
    ]);
    expect(approved.get('b')).toBe(0);
  });
});
