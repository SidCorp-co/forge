import type { IssueStatus } from '@forge/contracts/issue-machine';
import { needsViewer } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

const now = new Date('2026-10-06T14:20:00Z');

const input = (
  status: IssueStatus,
  over: Partial<IssueStandingInput> = {},
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
  criteria: { total: 2, passing: 2, failing: 0, skipped: 0 },
  requirement: null,
  module: null,
  feedback: [],
  branch: null,
  headSha: null,
  owner: null,
  touchedAt: now,
  releaseApproval: false,
  viewer: { userId: 'u1', canWrite: true },
  withheld: null,
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
