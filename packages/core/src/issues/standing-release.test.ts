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
  writers: ['Ann'],
  admins: [],
  withheld: null,
  statusSince: now,
  master: 'serves',
  judge: 'self',
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
  it('reads a hold a person owes as stuck on the writers by name, never on "You", the hold its rule', () => {
    const s = derive(atGate({ releaseHold: personHold }));
    expect(s.releaseHold).toEqual(personHold);
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'person', act: 'record the landing' });
    expect(s.waitingOn.rule).toBe(`NO_RELEASE_GATE: ${personHold.reason}`);
  });

  it('names the writers, and nobody where none can', () => {
    const named = derive(atGate({ releaseHold: personHold }));
    expect(named.waitingOn).toMatchObject({ kind: 'person', who: 'Ann' });
    expect(named.attentionGroup).toBe('stuck');
    const nobody = derive(atGate({ releaseHold: personHold, writers: [] }));
    expect(nobody.waitingOn.kind).toBe('none');
    expect(nobody.attentionGroup).toBe('stuck');
    expect(nobody.waitingOn.rule).toContain('NO_RELEASE_GATE');
  });

  it('reads a hold the release owes as queued on the release', () => {
    const s = derive(atGate({ releaseHold }));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({
      kind: 'release',
      act: 'take it in a later release',
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

describe('who clears a release hold, and the act, in plain words (ISS-684)', () => {
  const runnerHold: ReleaseHoldView = {
    code: 'NO_RUNNER_ONLINE',
    reason: 'The automatic release was refused: no runner serving this project is online.',
    owes: 'human',
    waitingFor: 'the refusal named here to be cleared',
    heldAt: '2026-10-23T23:50:00.000Z',
  };

  it('names the runner owner and the verb that clears a hold no runner online can take', () => {
    const s = derive(atGate({ releaseHold: runnerHold }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({
      kind: 'person',
      who: "The runner's owner",
      act: 'bring a runner online',
    });
    expect(s.waitingOn.rule).toContain('NO_RUNNER_ONLINE');
  });

  it('says a code it has no words for plainly by who owes it, never the waiting-for noun', () => {
    const human = derive(atGate({ releaseHold: { ...runnerHold, code: 'RELEASE_SOMETHING_NEW' } }));
    expect(human.waitingOn).toMatchObject({ kind: 'person', who: 'Ann', act: 'clear the refusal' });
    const agent = derive(
      atGate({ releaseHold: { ...runnerHold, code: 'RELEASE_SOMETHING_NEW', owes: 'agent' } }),
    );
    expect(agent.attentionGroup).toBe('queued');
    expect(agent.waitingOn).toMatchObject({ kind: 'release', act: 'release it on a later sweep' });
  });
});

describe('an issue with no release hold (ISS-577 criterion 3)', () => {
  // each release rule as the gate read it before a hold was served, pinned word for word
  it.each([
    [
      'a criterion no longer met',
      { criteria: { total: 2, met: 1, failing: 0, skipped: 0 } },
      { group: 'queued', kind: 'master', act: 'record its verdicts at the landing' },
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

// "Master · judge it again" stood beside Awaiting release on agenfold, aged now, its project's qa self
// (ISS-1072, the coordinator's live check of 2026-11-07): a criterion no longer met at the gate is
// owed by the project's judge as `strand-rules.ts:landedWait` reads it, and falls stuck by the judge's
// clock, never the moment it is read
describe('an issue at the gate a criterion of which is no longer met', () => {
  const stale = { criteria: { total: 3, met: 1, failing: 0, skipped: 0 } };

  it('waits on the master to record its verdicts again where the project judges its own work', () => {
    for (const judge of ['self', 'builder'] as const) {
      const s = derive(atGate({ ...stale, judge }));
      expect(s.attentionGroup).toBe('queued');
      expect(s.waitingOn).toMatchObject({
        kind: 'master',
        who: 'Master',
        act: 'record its verdicts at the landing',
      });
      expect(s.times.stuck).toBeNull();
    }
  });

  it('waits on a judging run where the project judges independently', () => {
    const s = derive(atGate({ ...stale, judge: 'independent' }));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'judge', who: 'Next run', act: 'judge it again' });
  });

  it('reads stuck once the judge day has passed', () => {
    const since = new Date('2026-10-20T00:00:00Z');
    const s = derive(atGate({ ...stale, statusSince: since, touchedAt: since }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck?.code).toBe('overdue');
  });
});
