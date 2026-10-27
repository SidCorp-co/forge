// ISS-1421 r37, judge-151 on criteria 366 and 367: the gate read "1 ready" over an issue with no
// release note and offered Release now, which the create door then refused. The gate reads the
// door's own enumerator, so a row is ready only where the press over it would not be refused.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import type { ReleaseRoster, ReleaseRosterEntry } from './queries.js';

const rosterMock = vi.fn<(projectId: string) => Promise<ReleaseRoster>>();
const blockersMock = vi.fn();

vi.mock('./queries.js', () => ({
  loadReleaseRoster: (projectId: string) => rosterMock(projectId),
}));
vi.mock('./blockers.js', () => ({
  collectReleaseBlockers: (projectId: string, options: unknown) => blockersMock(projectId, options),
}));

const { loadReleaseGateRoster } = await import('./gate-roster.js');

function row(id: string, claimedByRunId: string | null = null): ReleaseRosterEntry {
  return {
    id,
    displayId: id,
    title: `issue ${id}`,
    mergedAt: '2026-10-20T00:00:00.000Z',
    mergedCommitSha: 'abc1234',
    waitingDays: 1,
    claimedByRunId,
    closeRefusals: [],
    closeFailure: null,
  };
}

function roster(
  issues: ReleaseRosterEntry[],
  gateStatus: 'awaiting_release' | null = 'awaiting_release',
): ReleaseRoster {
  return {
    gateStatus,
    channels: ['coolify'],
    releaseRunnerLabel: null,
    baseBranch: 'main',
    nextCutAt: null,
    automaticRelease: false,
    currentVersion: null,
    issues,
  };
}

function reports(...blockers: ReleaseBlocker[]) {
  blockersMock.mockResolvedValueOnce({
    projectId: 'p',
    projectExists: true,
    declaration: null,
    channels: [],
    blockers,
    warnings: [],
  });
}

beforeEach(() => {
  rosterMock.mockReset();
  blockersMock.mockReset();
});

describe('the release gate a person reads', () => {
  it('asks the create door, over every unclaimed row, what Release now would be refused for', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a'), row('b', 'run-1'), row('c')]));
    reports();

    await loadReleaseGateRoster('p');

    expect(blockersMock).toHaveBeenCalledWith('p', { door: 'batch', issueIds: ['a', 'c'] });
  });

  it('marks a row with no release note not ready, saying what makes it ready in plain words', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a'), row('b')]));
    reports(blocker('RELEASE_RECORD_MISSING', { issueIds: ['b'], displayIds: ['b'] }));

    const gate = await loadReleaseGateRoster('p');

    expect(gate.issues[0]?.releaseRefusals).toEqual([]);
    const [refusal] = gate.issues[1]?.releaseRefusals ?? [];
    expect(refusal?.code).toBe('RELEASE_RECORD_MISSING');
    expect(refusal?.said).toMatch(/^It has no release note/);
    expect(refusal?.saidHere).toMatch(/^This issue has no release note/);
    for (const said of [refusal?.said, refusal?.saidHere]) {
      expect(said).toMatch(
        /A member of the project writes one under Release note on (this|the issue's) page/,
      );
      expect(said).not.toMatch(/ready once/);
      expect(said).not.toMatch(/releaseNotes|userFacing|[{}`]/);
    }
    expect(gate.blockingAll).toEqual([]);
  });

  // Consult F1: a row can owe its close something as well as its note, so the note's sentence
  // promises nothing beyond the note, and the close's refusal stays on the row beside it.
  it('keeps both on a row that owes its close something as well as its note', async () => {
    const owing = {
      ...row('a'),
      closeRefusals: [
        {
          code: 'OPEN_QUESTIONS' as const,
          reason: 'holds 1 open question',
          clears: 'Answer it.',
          said: 'x',
          saidHere: 'x',
        },
      ],
    };
    rosterMock.mockResolvedValueOnce(roster([owing]));
    reports(blocker('RELEASE_RECORD_MISSING', { issueIds: ['a'] }));

    const gate = await loadReleaseGateRoster('p');

    expect(gate.issues[0]?.closeRefusals).toHaveLength(1);
    expect(gate.issues[0]?.releaseRefusals.map((r) => r.code)).toEqual(['RELEASE_RECORD_MISSING']);
    expect(gate.issues[0]?.releaseRefusals[0]?.said).not.toMatch(/ready once|is ready/);
  });

  it("says once, in a person's words, a refusal no pick escapes", async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a')]));
    reports(blocker('RELEASE_POOL_EMPTY'), blocker('BATCH_IN_FLIGHT', { runId: 'run-9' }));

    const gate = await loadReleaseGateRoster('p');

    expect(gate.blockingAll.map((b) => b.code)).toEqual(['RELEASE_POOL_EMPTY', 'BATCH_IN_FLIGHT']);
    expect(gate.blockingAll[0]?.said).toMatch(/no runner registered/);
    expect(gate.blockingAll.map((b) => b.runId)).toEqual([null, 'run-9']);
    expect(gate.issues[0]?.releaseRefusals).toEqual([]);
  });

  // Judge-155 at c0f8105: the running release carried ISS-3 only, the gate said a second one would
  // claim the same issues, and it linked to no run.
  it('names what a running release carries, what the waiting rows do, and links its run', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('ISS-1'), row('ISS-2'), row('ISS-3', 'run-9')]));
    reports(blocker('BATCH_IN_FLIGHT', { runId: 'run-9', carries: ['ISS-3'] }));

    const gate = await loadReleaseGateRoster('p');

    expect(gate.blockingAll).toEqual([
      {
        code: 'BATCH_IN_FLIGHT',
        runId: 'run-9',
        said: 'A release is already running for this project, carrying ISS-3. A project runs one release at a time, so ISS-1 and ISS-2 are on no release and wait until it finishes.',
      },
    ]);
  });

  it('leaves to each row what its close refuses, and to the press what a pick decides', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a')]));
    reports(
      blocker('RELEASE_ISSUES_UNCLOSABLE', { issueIds: ['a'], refused: [] }),
      blocker('RELEASE_WORK_UNMERGED', { issueIds: ['a'], shape: 'git' }),
      blocker('CLAIM_CONFLICT', { issueIds: ['a'] }),
      blocker('RELEASE_ROSTER_OVERSIZE', { waiting: 51, limit: 50 }),
    );

    const gate = await loadReleaseGateRoster('p');

    expect(gate.blockingAll).toEqual([]);
    expect(gate.issues[0]?.releaseRefusals).toEqual([]);
  });

  it('says a check it could not run, rather than calling the rows ready', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a')]));
    reports(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'release-record', detail: 'timeout' }));

    const gate = await loadReleaseGateRoster('p');

    expect(gate.blockingAll.map((b) => b.code)).toEqual(['RELEASE_CHECK_UNEVALUATED']);
    expect(gate.blockingAll[0]?.said).toMatch(/^Reading which issues have a release note failed/);
  });

  it('asks nothing where nothing could be pressed: no gate, or every row already in a release', async () => {
    rosterMock.mockResolvedValueOnce(roster([row('a', 'run-1')]));
    const claimed = await loadReleaseGateRoster('p');
    rosterMock.mockResolvedValueOnce(roster([], null));
    const ungated = await loadReleaseGateRoster('p');

    expect(blockersMock).not.toHaveBeenCalled();
    expect(claimed.blockingAll).toEqual([]);
    expect(claimed.issues[0]?.releaseRefusals).toEqual([]);
    expect(ungated.blockingAll).toEqual([]);
  });
});
