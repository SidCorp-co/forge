// REQ-48 BC-5, BC-9 (docs/proposals/steward-agent.md, "Stuck rule" and "Roll-up"). On dev, 2026-10-21,
// REQ-45 waited on "Master · take ISS-498" grouped Moving: ISS-498 was sent back on 10-14 and no
// master served the project, yet the requirement read its issues' statuses and never their own
// standing. The issue's own standing now reads stuck where nobody serves its wait, and the
// requirement it carries reads stuck by it, the issue named.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { MasterServing } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput } from '../issues/standing.js';
import { deriveStanding, type StandingInput, type StandingIssue } from './standing.js';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-21T09:00:00Z');
const SENT_BACK = at('2026-10-14T08:00:00Z');

const issueInput = (status: IssueStatus, master: MasterServing): IssueStandingInput => ({
  status,
  leftStatus: null,
  designOnly: false,
  holdsDependents: false,
  waitingKind: null,
  merged: false,
  step: null,
  stepStartedAt: null,
  lease: null,
  inFlight: false,
  runLive: false,
  owesAnswer: false,
  blockedBy: [],
  blocks: [],
  criteria: { total: 0, met: 0, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: NOW,
  releaseApproval: false,
  releaseNoted: true,
  releaseHold: null,
  viewer: null,
  writers: ['Ana'],
  admins: ['Ana'],
  withheld: null,
  statusSince: SENT_BACK,
  master,
  now: NOW,
});

/** ISS-498 as the requirement reads it: its status, and its own standing (`standing-read.ts:ownOf`). */
function carrier(status: IssueStatus, master: MasterServing): StandingIssue {
  const own = deriveIssueStanding(issueInput(status, master));
  return {
    id: 'i498',
    displayId: 'ISS-498',
    title: 'Sent back',
    status,
    tone: 'neutral',
    updatedAt: NOW,
    closedAt: null,
    changedSincePlan: false,
    parkedOn: null,
    own: { waitingOn: own.waitingOn, since: new Date(own.times.since), stuck: own.times.stuck },
  } as StandingIssue;
}

const requirement = (issues: StandingIssue[], master: MasterServing): StandingInput => ({
  status: 'agreed',
  owner: { id: 'u1', name: 'Ba', kind: 'human' },
  viewer: null,
  revisions: [
    {
      revision: 2,
      state: 'current',
      authorId: 'u1',
      authorName: 'Ba',
      authorKind: 'human',
      authorAgency: 'human',
      createdAt: at('2026-10-01T00:00:00Z'),
      proposedAt: at('2026-10-01T00:00:00Z'),
      decidedAt: at('2026-10-02T00:00:00Z'),
    },
  ],
  currentRevision: 2,
  criteria: [],
  issues,
  issueCriteria: [],
  openSuggestionKinds: [],
  stalePins: [],
  staleContractPins: [],
  unapprovedDesigns: [],
  feedback: { open: 0, untriaged: [] },
  judge: 'self',
  runnerBound: true,
  agreedAt: at('2026-10-02T00:00:00Z'),
  release: null,
  updatedAt: NOW,
  statusSince: at('2026-10-02T00:00:00Z'),
  master,
  now: NOW,
});

describe("REQ-45's shape: a reopened carrier no master serves", () => {
  it('reads the issue itself stuck, nobody serving it, since it was sent back', () => {
    const s = deriveIssueStanding(issueInput('reopen', 'none'));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck).toMatchObject({ code: 'nobody_serves', since: SENT_BACK.toISOString() });
    expect(s.times.stuck?.reason).toBe(
      'It waits on the master, and no master serves this project.',
    );
  });

  it('reads the requirement stuck by ISS-498, never Moving, with the issue named', () => {
    const s = deriveStanding(requirement([carrier('reopen', 'none')], 'none'));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.attentionGroup).not.toBe('moving');
    expect(s.times).toMatchObject({ carriedBy: 'ISS-498' });
    expect(s.times.stuck).toMatchObject({ code: 'nobody_serves', via: 'ISS-498' });
    expect(s.times.stuck?.reason).toBe(
      'ISS-498: It waits on the master, and no master serves this project.',
    );
    expect(s.waitingOn.ref).toBe('ISS-498');
  });

  it('reads a silent master the same way, naming it silent', () => {
    const s = deriveStanding(requirement([carrier('reopen', 'silent')], 'silent'));
    expect(s.times.stuck?.code).toBe('nobody_serves');
    expect(s.times.stuck?.reason).toContain('gone silent');
  });

  it('reads an open carrier stuck too once its take falls a working day overdue, a master serving', () => {
    const s = deriveStanding(requirement([carrier('open', 'serves')], 'serves'));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck).toMatchObject({ code: 'overdue', via: 'ISS-498' });
  });

  it('keeps a carrier a serving master took within the day moving, its due named', () => {
    const fresh = { ...requirement([], 'serves'), now: at('2026-10-14T12:00:00Z') };
    const own = deriveIssueStanding({ ...issueInput('open', 'serves'), now: fresh.now });
    const issue = {
      ...carrier('open', 'serves'),
      own: { waitingOn: own.waitingOn, since: SENT_BACK, stuck: own.times.stuck },
    } as StandingIssue;
    const s = deriveStanding({ ...fresh, issues: [issue] });
    expect(s.attentionGroup).toBe('moving');
    expect(s.times.stuck).toBeNull();
    expect(s.times.dueAt).toBe('2026-10-15T08:00:00.000Z');
  });
});

describe('a requirement with no owner', () => {
  it('reads stuck no_owner, the wait an owner to assign', () => {
    const s = deriveStanding({ ...requirement([], 'serves'), owner: null });
    expect(s.times.stuck?.code).toBe('no_owner');
    expect(s.waitingOn.says.act.key).toBe('requirements.act.assignOwner');
  });
});
