import { saidDisagreements } from '@forge/contracts/said';
// @direct-test-of packages/core/src/issues/standing.ts
// FB-104: a draft read "Waits on A project writer" — dev's ISS-146..148 and REQ-17 — naming nobody,
// so a reader could not tell who that was or whether anyone was. A person's turn now names the
// project's writers, or says that no person holds write and where an admin grants it.
// ISS-687 (REQ-68 BC-4, BC-6): no issue asks its reader to act. Judge K163 read the Issues list's
// Needs you group asking "You · take on or drop", "You · resume once", "You · answer a question" and
// "You · make a decision"; a draft and a resume are the master's now, and an answer names its people.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import {
  deriveIssueStanding as deriveIssueStanding_,
  type IssueStandingInput,
} from './standing.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const deriveIssueStanding = ((...a: Parameters<typeof deriveIssueStanding_>) =>
  checked(deriveIssueStanding_(...a))) as typeof deriveIssueStanding_;

const now = new Date('2026-10-07T10:00:00Z');

const input = (status: IssueStatus, writers: string[]): IssueStandingInput => ({
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
  touchedAt: now,
  releaseApproval: false,
  releaseNoted: true,
  releaseHold: null,
  writers,
  admins: [],
  withheld: null,
  statusSince: now,
  master: 'serves',
  now,
});

const parked = (writers: string[], waitingKind: string) => ({
  ...input('needs_info', writers),
  waitingKind,
});

describe("a person's answer names who can give it", () => {
  it('names the one writer, or each of a few, and counts the rest', () => {
    expect(deriveIssueStanding(parked(['Ana'], 'needs_answer')).waitingOn).toMatchObject({
      kind: 'person',
      who: 'Ana',
      act: 'answer a question',
    });
    expect(deriveIssueStanding(parked(['Ana', 'Bo'], 'needs_answer')).waitingOn.who).toBe(
      'Ana, Bo',
    );
    expect(
      deriveIssueStanding(parked(['Ana', 'Bo', 'Chi', 'Dao', 'Em'], 'needs_answer')).waitingOn.who,
    ).toBe('Ana, Bo, Chi +2');
  });

  it('says no person holds write, and where it is granted, when nobody does', () => {
    const s = deriveIssueStanding(parked([], 'needs_answer'));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(s.waitingOn.act).toBe(
      'answer a question: nobody holds project.write; grant it under Settings → Members',
    );
  });

  it.each(['needs_answer', 'needs_decision', 'needs_resource'])(
    'groups a needs_info park (%s) as waiting on the writers, never needs_you',
    (kind) => {
      const s = deriveIssueStanding(parked(['Ana'], kind));
      expect(s.attentionGroup).toBe('queued');
      expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana' });
    },
  );

  it('groups a question a run asked as waiting on the writers, never needs_you', () => {
    const s = deriveIssueStanding({ ...input('in_progress', ['Ana']), owesAnswer: true });
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana', act: 'answer a question' });
  });
});

describe("a draft and a resume are the master's, never a person's (REQ-68)", () => {
  it('a draft waits on the master to take it on or drop it, whoever may admit', () => {
    const s = deriveIssueStanding(input('draft', ['Ana']));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({
      kind: 'master',
      who: 'Master',
      act: 'take on or drop',
      rule: 'a draft is not work until the master takes it on',
    });
  });

  it('a draft with no writer on the project still waits on the master, not on nobody', () => {
    expect(deriveIssueStanding(input('draft', [])).waitingOn.kind).toBe('master');
  });

  it('an issue a person paused waits on the master to resume it', () => {
    const s = deriveIssueStanding(input('on_hold', ['Ana']));
    expect(s.attentionGroup).toBe('paused');
    expect(s.waitingOn).toMatchObject({ kind: 'master', act: 'resume it' });
  });

  it.each([
    ['a hold the answer named', { hold: { reason: 'the fix round is queued', blockedBy: null } }],
    ['a resume nobody recorded', { hold: null, resume: null }],
    ['a staged resume', { hold: null, resume: { kind: 'staged' } }],
    ['no status to return to', { hold: null, resume: { kind: 'no_left_status' } }],
  ])('a park answered with %s waits on the master to resume it once', (_, answered) => {
    const s = deriveIssueStanding({
      ...input('needs_info', ['Ana']),
      answered: answered as NonNullable<IssueStandingInput['answered']>,
    });
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(s.waitingOn.kind).toBe('master');
  });
});

// R-12: every draft behind a live blocks edge read "You · take on or drop", inflating Waiting on you
describe('a draft behind a live blocker', () => {
  const blocker = {
    id: 'b1',
    key: 'ISS-3',
    title: 'The blocker',
    status: 'in_progress' as const,
    merged: false,
    step: null,
    holds: true,
  };

  it('waits on its blocker first', () => {
    const s = deriveIssueStanding({ ...input('draft', ['Ana']), blockedBy: [blocker] });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'issue', who: 'ISS-3', ref: 'ISS-3' });
  });

  it("is the master's turn again once the blocker no longer holds", () => {
    const s = deriveIssueStanding({
      ...input('draft', ['Ana']),
      blockedBy: [{ ...blocker, holds: false }],
    });
    expect(s.waitingOn).toMatchObject({ kind: 'master', act: 'take on or drop' });
  });
});

// ISS-687 c1, c3: whatever the issue owes, its row asks no reader to act on it.
describe('no issue asks its reader to act', () => {
  const statuses: IssueStatus[] = [
    'draft',
    'open',
    'approved',
    'in_progress',
    'needs_info',
    'on_hold',
    'reopen',
    'awaiting_release',
    'closed',
    'dropped',
  ];
  it.each(statuses)('a %s issue groups no Needs you and names no "You"', (status) => {
    for (const extra of [{}, { owesAnswer: true }, { waitingKind: 'needs_decision' }]) {
      const s = deriveIssueStanding({ ...input(status, ['Ana']), ...extra });
      expect(s.attentionGroup).not.toBe('needs_you');
      expect(s.waitingOn.kind).not.toBe('you');
      expect(s.waitingOn.who).not.toBe('You');
    }
  });
});
