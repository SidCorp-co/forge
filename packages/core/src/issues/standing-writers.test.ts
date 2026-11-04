import { saidDisagreements } from '@forge/contracts/said';
// @direct-test-of packages/core/src/issues/standing.ts
// FB-104: a draft read "Waits on A project writer" — dev's ISS-146..148 and REQ-17 — naming nobody,
// so a reader could not tell who that was or whether anyone was. A person's turn now names the
// project's writers, or says that no person holds write and where an admin grants it.
// ISS-687 (REQ-68 BC-4, BC-6): no issue asks its reader to act. Judge K163 read the Issues list's
// Needs you group asking "You · take on or drop", "You · resume once", "You · answer a question" and
// "You · make a decision"; a draft and a resume are the master's now, and an answer owed names nobody.

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

// ISS-687 round 2 (judge run 6c6e24b4 at dev.485): four parked rows still read "orchestrator, qa ·
// answer a question" and ISS-643's page "Orchestrator and QA must answer the question". An issue a
// person owes an answer waits on the answer, naming no person and no act; the question is asked in
// Needs you, on the item it is about. Planted red by putting back the holders' names and the act.
describe('a question a person owes reads as the answer the issue waits on, naming no one', () => {
  it.each([
    ['needs_answer', 'An answer'],
    ['needs_decision', 'A decision'],
    ['needs_resource', 'Something supplied'],
  ])('a needs_info park (%s) waits on %s, queued, with no act and no name', (kind, owed) => {
    const s = deriveIssueStanding(parked(['Ana', 'Bo'], kind));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'answer', who: owed, act: '' });
    expect(JSON.stringify(s.waitingOn)).not.toMatch(/Ana|Bo\b|answer a question|make a decision/);
  });

  it('a question a run asked waits on an answer, never on the writers', () => {
    const s = deriveIssueStanding({ ...input('in_progress', ['Ana']), owesAnswer: true });
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'answer', who: 'An answer', act: '' });
  });

  it('a run that parked it on_hold with a question waits on an answer too', () => {
    const s = deriveIssueStanding({
      ...input('on_hold', ['Ana']),
      owesAnswer: true,
      park: { reason: 'which plan applies?', byAgent: true },
    });
    expect(s.waitingOn).toMatchObject({ kind: 'answer', who: 'An answer', act: '' });
  });

  it('reads stuck where nobody holds write, the rule saying where it is granted, still naming no act', () => {
    const s = deriveIssueStanding(parked([], 'needs_answer'));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'answer', who: 'An answer', act: '' });
    expect(s.waitingOn.rule).toContain('no person holds project.write');
  });

  it('falls overdue as the answer being due, never as someone who owed it', () => {
    const since = new Date('2026-09-01T10:00:00Z');
    const s = deriveIssueStanding({ ...parked(['Ana'], 'needs_answer'), statusSince: since });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck?.code).toBe('overdue');
    expect(s.times.stuck?.reason).toMatch(/^An answer was due by \d{4}-\d{2}-\d{2}\.$/);
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
