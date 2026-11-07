/**
 * @direct-test-of packages/core/src/issues/standing.ts
 * @direct-test-of packages/core/src/issues/standing-held.ts
 * @direct-test-of packages/core/src/lib/standing-act-class.ts
 */
import { type IssueStatus, TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import {
  deriveIssueStanding as deriveIssueStanding_,
  type IssueStandingInput,
  type StandingEdge,
} from './standing.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const deriveIssueStanding = ((...a: Parameters<typeof deriveIssueStanding_>) =>
  checked(deriveIssueStanding_(...a))) as typeof deriveIssueStanding_;

const now = new Date('2026-10-09T14:20:00Z');
/** Three working days before `now`: a wait due in one is long past it. */
const threeDaysAgo = new Date('2026-10-06T14:20:00Z');

const input = (
  status: IssueStatus,
  over: Partial<IssueStandingInput> = {},
): IssueStandingInput => ({
  status,
  leftStatus: null,
  designOnly: false,
  holdsDependents: false,
  waitingKind: null,
  merged: false,
  mergedSinceReopen: false,
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
  writers: [],
  admins: [],
  withheld: null,
  statusSince: now,
  master: 'serves',
  judge: 'self',
  now,
  ...over,
});

// A queue is not stuck (ISS-1072, the coordinator's live check of 2026-11-07): an issue waiting its
// turn in the master's queue reads queued however long it has waited, and stuck only where no master
// serves. An issue behind a blocker that is moving waits on it; it is stuck only when that blocker is
// itself stuck or nobody holds it.
const blocker = (over: Partial<StandingEdge> = {}): StandingEdge => ({
  id: 'b1',
  key: 'ISS-1072',
  title: 'The list screens',
  status: 'in_progress',
  merged: false,
  step: 'build',
  holds: true,
  ...over,
});

describe("an issue in the master's queue", () => {
  it.each([...TAKEABLE_STATUSES])(
    'reads queued, never stuck, when it has waited three working days at %s',
    (status) => {
      const s = deriveIssueStanding(
        input(status, { statusSince: threeDaysAgo, touchedAt: threeDaysAgo }),
      );
      expect(s.attentionGroup).toBe('queued');
      expect(s.times.stuck).toBeNull();
      expect(s.times.dueAt).toBeNull();
    },
  );

  it('reads stuck where no master serves the project', () => {
    const s = deriveIssueStanding(input('open', { statusSince: threeDaysAgo, master: 'none' }));
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck?.code).toBe('nobody_serves');
  });
});

describe('an issue behind a live blocker', () => {
  it('waits on a blocker that is moving: queued, the blocker named', () => {
    const s = deriveIssueStanding(
      input('open', { blockedBy: [blocker()] }),
      new Map([['b1', 'moving']]),
    );
    expect(s.attentionGroup).toBe('queued');
    expect(s.times.stuck).toBeNull();
    expect(s.waitingOn.who).toBe('ISS-1072');
  });

  it('waits on a blocker queued behind its own turn', () => {
    const s = deriveIssueStanding(
      input('open', { blockedBy: [blocker({ status: 'open', step: null })] }),
      new Map([['b1', 'queued']]),
    );
    expect(s.attentionGroup).toBe('queued');
  });

  it('is stuck when its blocker is stuck, nobody holding it', () => {
    const s = deriveIssueStanding(
      input('open', { blockedBy: [blocker()] }),
      new Map([['b1', 'stuck']]),
    );
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck?.code).toBe('blocked');
  });

  it("is stuck when its blocker's own standing was not read", () => {
    expect(deriveIssueStanding(input('open', { blockedBy: [blocker()] })).attentionGroup).toBe(
      'stuck',
    );
  });
});
