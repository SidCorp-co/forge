import type { ReleaseHoldView } from '@forge/contracts/releases';
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

const now = new Date('2026-10-24T00:00:00Z');

const atGate = (over: Partial<IssueStandingInput> = {}): IssueStandingInput => ({
  status: 'awaiting_release',
  leftStatus: null,
  designOnly: false,
  holdsDependents: false,
  waitingKind: null,
  merged: true,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  runLive: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria: { total: 2, met: 2, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: now,
  releaseApproval: false,
  releaseNoted: true,
  releaseHold: null,
  viewer: { userId: 'u1', canWrite: true },
  writers: ['Ann'],
  admins: [],
  withheld: null,
  statusSince: now,
  master: 'serves',
  now,
  ...over,
});

const derive = (input: IssueStandingInput) => {
  const s = deriveIssueStanding(input);
  expect(saidDisagreements(s)).toEqual([]);
  return s;
};

const personHold: ReleaseHoldView = {
  code: 'NO_RELEASE_GATE',
  reason: 'This project declares no production environment, so no automatic release carries it.',
  owes: 'human',
  waitingFor: 'a person to record the landing',
  heldAt: '2026-10-23T23:00:00.000Z',
};
const releaseHold: ReleaseHoldView = {
  code: 'RELEASE_QUEUED_BEHIND',
  reason: 'One release carries at most 5 issues, and this one is behind them.',
  owes: 'agent',
  waitingFor: 'a later automatic release',
  heldAt: '2026-10-23T23:00:00.000Z',
};

describe('a held issue at the release gate (ISS-577 criterion 2)', () => {
  it('reads a hold a person owes as stuck on the viewer who can write, the hold its rule', () => {
    const s = derive(atGate({ releaseHold: personHold }));
    expect(s.releaseHold).toEqual(personHold);
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'you', act: personHold.waitingFor });
    expect(s.waitingOn.rule).toBe(`NO_RELEASE_GATE: ${personHold.reason}`);
  });

  it('names the writers to a viewer who cannot act, and nobody where none can', () => {
    const named = derive(atGate({ releaseHold: personHold, viewer: null }));
    expect(named.waitingOn).toMatchObject({ kind: 'person', who: 'Ann' });
    expect(named.attentionGroup).toBe('stuck');
    const nobody = derive(atGate({ releaseHold: personHold, viewer: null, writers: [] }));
    expect(nobody.waitingOn.kind).toBe('none');
    expect(nobody.attentionGroup).toBe('stuck');
    expect(nobody.waitingOn.rule).toContain('NO_RELEASE_GATE');
  });

  it('reads a hold the release owes as queued on the release', () => {
    const s = derive(atGate({ releaseHold }));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({
      kind: 'release',
      act: 'a later automatic release',
      rule: `RELEASE_QUEUED_BEHIND: ${releaseHold.reason}`,
    });
  });

  it('outranks every release rule a held row would otherwise read', () => {
    for (const over of [
      { criteria: { total: 2, met: 1, failing: 0, skipped: 0 } },
      { releaseNoted: false },
      { releaseApproval: true },
      { inFlight: true },
      {},
    ] as Partial<IssueStandingInput>[]) {
      const s = derive(atGate({ ...over, releaseHold: personHold }));
      expect(s.waitingOn.rule).toContain('NO_RELEASE_GATE');
      expect(s.waitingOn.act).not.toBe('next release');
    }
  });
});

describe('an issue with no release hold (ISS-577 criterion 3)', () => {
  // each release rule as the gate read it before a hold was served, pinned word for word
  it.each([
    [
      'a criterion no longer met',
      { criteria: { total: 2, met: 1, failing: 0, skipped: 0 } },
      { group: 'stuck', kind: 'master', act: 'judge it again' },
    ],
    [
      'no release note',
      { releaseNoted: false },
      { group: 'queued', kind: 'master', act: 'write the release note' },
    ],
    [
      'an approval owed',
      { releaseApproval: true },
      { group: 'queued', kind: 'release', act: 'Approve release on Releases' },
    ],
    ['a release running', { inFlight: true }, { group: 'moving', kind: 'run', act: 'running' }],
    ['nothing else', {}, { group: 'queued', kind: 'release', act: 'next release' }],
  ] as const)('keeps its turn: %s', (_, over, want) => {
    const s = derive(atGate(over as Partial<IssueStandingInput>));
    expect(s.releaseHold).toBeNull();
    expect(s.attentionGroup).toBe(want.group);
    expect(s.waitingOn).toMatchObject({ kind: want.kind, act: want.act });
    expect(s.waitingOn.rule).not.toMatch(/NO_RELEASE_GATE|RELEASE_QUEUED_BEHIND/);
  });

  it('serves no hold off the gate, whatever the input carries', () => {
    const s = derive(atGate({ status: 'reopen', merged: false, releaseHold: personHold }));
    expect(s.releaseHold).toBeNull();
    expect(s.waitingOn.rule).not.toContain('NO_RELEASE_GATE');
  });
});
