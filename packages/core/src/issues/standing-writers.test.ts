// FB-104: a draft read "Waits on A project writer" — dev's ISS-146..148 and REQ-17 — naming nobody,
// so a reader could not tell who that was or whether anyone was. A person's turn now names the
// project's writers, or says that no person holds write and where an admin grants it.

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

const now = new Date('2026-10-07T10:00:00Z');

const input = (
  status: IssueStatus,
  writers: string[],
  viewer: IssueStandingInput['viewer'] = null,
): IssueStandingInput => ({
  status,
  leftStatus: null,
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
  criteria: { total: 0, passing: 0, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: now,
  releaseApproval: false,
  releaseNoted: true,
  viewer,
  writers,
  withheld: null,
  now,
});

describe("a person's turn names who can take it", () => {
  it('names the one writer, or each of a few, and counts the rest', () => {
    expect(deriveIssueStanding(input('draft', ['Ana'])).waitingOn).toMatchObject({
      kind: 'person',
      who: 'Ana',
      act: 'take on or drop',
    });
    expect(deriveIssueStanding(input('draft', ['Ana', 'Bo'])).waitingOn.who).toBe('Ana, Bo');
    expect(
      deriveIssueStanding(input('draft', ['Ana', 'Bo', 'Chi', 'Dao', 'Em'])).waitingOn.who,
    ).toBe('Ana, Bo, Chi +2');
  });

  it('says no person holds write, and where an admin grants it, when nobody does', () => {
    const s = deriveIssueStanding(input('draft', []));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(s.waitingOn.act).toBe(
      'take on or drop: no person on this project can write until a project admin grants write under Settings → Members',
    );
  });

  it('still addresses a viewer who can write as You', () => {
    const s = deriveIssueStanding(input('draft', [], { userId: 'u1', canWrite: true }));
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You' });
  });
});
