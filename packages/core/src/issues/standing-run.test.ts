import type { IssueStatus } from '@forge/contracts/issue-machine';
import { saidDisagreements } from '@forge/contracts/said';
import { needsViewer } from '@forge/contracts/standing';
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

const now = new Date('2026-10-06T14:20:00Z');

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

// F6: the header reads the run the fleet lease names live, never "Queued run · starting" beside a live heartbeat
describe('an issue a live run session holds', () => {
  it('reads Run, not Queued run, when the run holds the fleet lease and the work-state lease is empty', () => {
    const s = deriveIssueStanding(input('in_progress', { inFlight: true, runLive: true }));
    expect(s.waitingOn.who).toBe('Run');
    expect(s.waitingOn.act).not.toBe('starting');
  });

  it('reads Queued run while only a queued job stands on it', () => {
    const s = deriveIssueStanding(input('in_progress', { inFlight: true, runLive: false }));
    expect(s.waitingOn.who).toBe('Queued run');
  });
});

// UI-E residual 1 (ISS-1109): a direct-mode master builds under its own lease with no run record; the
// row named that build "Run · Build" while the runs read counted no run, so a lease the master holds
// with no live run is the master's build, and a real run over it keeps Run
describe('an issue the master leases with no run over it', () => {
  const lease = { holder: 'forge-master-sid-xeon-1', verdict: 'live', expiresAt: null } as const;
  const at = new Date(now.getTime() - 30 * 60_000);

  it('reads Master at its step, not Run', () => {
    const s = deriveIssueStanding(
      input('in_progress', { lease, leaseByMaster: true, step: 'build', stepStartedAt: at }),
    );
    expect(s.attentionGroup).toBe('moving');
    expect(s.waitingOn.kind).toBe('master');
    expect(s.waitingOn.who).toBe('Master');
    expect(s.waitingOn.act).toBe('Build · 30 min');
  });

  it("keeps Run where a live run holds it, even under the master's lease", () => {
    const s = deriveIssueStanding(
      input('in_progress', { lease, leaseByMaster: true, runLive: true, inFlight: true }),
    );
    expect(s.waitingOn.who).toBe('Run');
  });

  it('keeps Run for a lease another holder holds', () => {
    const s = deriveIssueStanding(input('in_progress', { lease, leaseByMaster: false }));
    expect(s.waitingOn.who).toBe('Run');
  });
});

// F11: approving is one act per release, on Releases, never one Needs-you row per issue it carries
describe('a merged issue on a project that approves its releases', () => {
  it('waits on its release, not on the viewer, and names the button that releases', () => {
    const s = deriveIssueStanding(
      input('awaiting_release', { merged: true, releaseApproval: true }),
    );
    expect(needsViewer(s)).toBe(false);
    expect(s.waitingOn.kind).toBe('release');
    expect(s.waitingOn.act).toContain('Approve release');
  });
});

// F72: an issue at the gate with no release note waits on the master that writes it, never on a release it cannot join
describe('a merged issue at the gate with no release note', () => {
  it('waits on the master to write the note, before any approval or release', () => {
    for (const releaseApproval of [true, false]) {
      const s = deriveIssueStanding(
        input('awaiting_release', { merged: true, releaseApproval, releaseNoted: false }),
      );
      expect(s.waitingOn).toMatchObject({ kind: 'master', act: 'write the release note' });
      expect(s.waitingOn.rule).toContain('RELEASE_RECORD_MISSING');
    }
  });
});
