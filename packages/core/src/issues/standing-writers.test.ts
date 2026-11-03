import { saidDisagreements } from '@forge/contracts/said';
// @direct-test-of packages/core/src/issues/standing.ts
// FB-104: a draft read "Waits on A project writer" — dev's ISS-146..148 and REQ-17 — naming nobody,
// so a reader could not tell who that was or whether anyone was. A person's turn now names the
// project's writers, or says that no person holds write and where an admin grants it.

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

const input = (
  status: IssueStatus,
  writers: string[],
  viewer: IssueStandingInput['viewer'] = null,
): IssueStandingInput => ({
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
  viewer,
  writers,
  admins: [],
  admit: { permission: 'project.write', holders: writers },
  withheld: null,
  statusSince: now,
  master: 'serves',
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

  it('says no person holds write, and where it is granted, when nobody does', () => {
    const s = deriveIssueStanding(input('draft', []));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(s.waitingOn.act).toBe(
      'take on or drop: nobody holds project.write; grant it under Settings → Members',
    );
  });

  it('still addresses a viewer who can write as You', () => {
    const s = deriveIssueStanding(
      input('draft', [], { userId: 'u1', canWrite: true, canAdmit: true }),
    );
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You' });
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

  it('waits on its blocker, never on a person, even for a viewer who can write', () => {
    const s = deriveIssueStanding({
      ...input('draft', ['Ana'], { userId: 'u1', canWrite: true, canAdmit: true }),
      blockedBy: [blocker],
    });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'issue', who: 'ISS-3', ref: 'ISS-3' });
  });

  it('is the person’s turn again once the blocker no longer holds', () => {
    const s = deriveIssueStanding({
      ...input('draft', ['Ana']),
      blockedBy: [{ ...blocker, holds: false }],
    });
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana', act: 'take on or drop' });
  });
});

// ISS-926: a read-only viewer's standing grouped "answer" needs_you while it named another person as
// owing it, so their Needs you and /attention counted a decision they could not take. The group now
// follows the kind and the permission the act asks together.
describe("a person's act is the viewer's only where they hold what it asks", () => {
  const reader = { userId: 'u9', canWrite: false, canAdmit: false };
  const writer = { userId: 'u1', canWrite: true, canAdmit: false };
  const admitter = { userId: 'u2', canWrite: true, canAdmit: true };
  const asked = (viewer: IssueStandingInput['viewer']) => ({
    ...input('in_progress', ['Ana'], viewer),
    owesAnswer: true,
  });
  const parked = (viewer: IssueStandingInput['viewer'], waitingKind: string) => ({
    ...input('needs_info', ['Ana'], viewer),
    waitingKind,
  });
  const strictDraft = (viewer: IssueStandingInput['viewer']) => ({
    ...input('draft', ['Ana', 'Bo'], viewer),
    admit: { permission: 'issues.admit' as const, holders: ['Bo'] },
  });

  it('groups a question owed to a read-only viewer as waiting on the writers, never needs_you', () => {
    const s = deriveIssueStanding(asked(reader));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana', act: 'answer a question' });
  });

  it.each(['needs_answer', 'needs_decision', 'needs_resource'])(
    'groups a needs_info park (%s) as waiting on the writers for a read-only viewer',
    (kind) => {
      const s = deriveIssueStanding(parked(reader, kind));
      expect(s.attentionGroup).toBe('queued');
      expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Ana' });
    },
  );

  it.each(['needs_answer', 'needs_decision', 'needs_resource'])(
    'keeps a needs_info park (%s) on the Needs you of a viewer who holds project.write',
    (kind) => {
      const s = deriveIssueStanding(parked(writer, kind));
      expect(s.attentionGroup).toBe('needs_you');
      expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You' });
    },
  );

  it('keeps a question owed on the Needs you of a viewer who holds project.write', () => {
    const s = deriveIssueStanding(asked(writer));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'answer a question' });
  });

  it('asks a draft of the admit gate: a writer without issues.admit waits on its holders', () => {
    const s = deriveIssueStanding(strictDraft(writer));
    expect(s.attentionGroup).toBe('queued');
    expect(s.waitingOn).toMatchObject({ kind: 'person', who: 'Bo', act: 'take on or drop' });
  });

  it('keeps a draft on the Needs you of a viewer who holds what the admit gate asks', () => {
    const s = deriveIssueStanding(strictDraft(admitter));
    expect(s.attentionGroup).toBe('needs_you');
    expect(s.waitingOn).toMatchObject({ kind: 'you', who: 'You', act: 'take on or drop' });
  });

  it('says nobody holds issues.admit, where it is granted, when the gate is on and nobody does', () => {
    const s = deriveIssueStanding({
      ...strictDraft(writer),
      admit: { permission: 'issues.admit', holders: [] },
    });
    expect(s.attentionGroup).toBe('stuck');
    expect(s.waitingOn).toMatchObject({ kind: 'none', who: 'Nobody' });
    expect(s.waitingOn.act).toBe(
      'take on or drop: nobody holds issues.admit; grant it under Settings → Members',
    );
  });

  it('never groups a row needs_you that names anyone but the viewer', () => {
    for (const viewer of [null, reader, writer, admitter]) {
      for (const i of [asked(viewer), parked(viewer, 'needs_decision'), strictDraft(viewer)]) {
        const s = deriveIssueStanding(i);
        expect(s.attentionGroup === 'needs_you').toBe(s.waitingOn.kind === 'you');
      }
    }
  });
});
