import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSweepCursorsForTest } from './sweep-cursor.js';

interface CandidateRow {
  id: string;
  project_id: string;
  cursor_ts: string;
}
let candidateRows: CandidateRow[] = [];
const dbExecute = vi.fn(async (..._args: unknown[]) => candidateRows);

interface CommentRow {
  issueId: string;
  authorId: string;
  body: string;
}
const insertedComments: CommentRow[] = [];
let existingCommentsByIssue: Record<string, string[]> = {};

interface IssueState {
  status: string;
  releaseBatchRunId: string | null;
}
/** Defaults every issue to untouched; a test overrides one entry to prove the claimed-already case. */
let issueStateByIssue: Record<string, IssueState> = {};

const selectFrom = vi.fn((columns: Record<string, unknown>) => ({
  from: (_table: unknown) => ({
    where: async () => {
      if ('status' in columns) {
        return Object.entries(issueStateByIssue).map(([id, s]) => ({ id, ...s }));
      }
      return Object.entries(existingCommentsByIssue).flatMap(([, bodies]) =>
        bodies.map((body) => ({ body })),
      );
    },
  }),
}));
const insertValues = vi.fn(async (values: CommentRow) => {
  insertedComments.push(values);
});
vi.mock('../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
    select: (columns: Record<string, unknown>) => selectFrom(columns),
    insert: (_table: unknown) => ({ values: (v: CommentRow) => insertValues(v) }),
  },
}));

vi.mock('../db/schema.js', () => ({ comments: {}, issues: {} }));

const releasesAutomaticallyMock = vi.fn(async (_projectId: string) => true);
vi.mock('./auto-release.js', () => ({
  projectReleasesAutomatically: (projectId: string) => releasesAutomaticallyMock(projectId),
}));

const resolveReleaseGateMock = vi.fn(
  async (_projectId: string) => 'awaiting_release' as string | null,
);
vi.mock('../release-batch/gate.js', () => ({
  resolveReleaseGate: (projectId: string) => resolveReleaseGateMock(projectId),
}));

interface RosterIssue {
  id: string;
  claimedByRunId: string | null;
}
const loadReleaseRosterMock = vi.fn(async (_projectId: string) => ({
  issues: [] as RosterIssue[],
}));
vi.mock('../release-batch/queries.js', () => ({
  loadReleaseRoster: (projectId: string) => loadReleaseRosterMock(projectId),
}));

const issuesWithUnearnedCriteriaMock = vi.fn(async (_ids: string[]) => [] as string[]);
vi.mock('../issues/criteria-verdicts.js', () => ({
  issuesWithUnearnedCriteria: (ids: string[]) => issuesWithUnearnedCriteriaMock(ids),
}));

const loadCreatedByMock = vi.fn(async (_projectId: string) => 'owner-1' as string | undefined);
vi.mock('../schedules/release-batch-dispatch.js', () => ({
  loadCreatedBy: (projectId: string) => loadCreatedByMock(projectId),
}));

interface CutOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
}
const cutWaitingReleaseMock = vi.fn(
  async (_args: {
    projectId: string;
    userId: string;
    issueIds: string[];
  }): Promise<CutOutcome> => ({
    status: 'success',
    output: 'cut 1 issue(s) as run run-1',
  }),
);
vi.mock('../schedules/release-batch-run.js', () => ({
  cutWaitingRelease: (args: { projectId: string; userId: string; issueIds: string[] }) =>
    cutWaitingReleaseMock(args),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { sweepAutomaticReleases } = await import('./release-sweep.js');

function candidateRow(projectId: string, issueId: string, ts: string): CandidateRow {
  return { id: issueId, project_id: projectId, cursor_ts: ts };
}

beforeEach(() => {
  resetSweepCursorsForTest();
  dbExecute.mockReset();
  candidateRows = [];
  dbExecute.mockImplementation(async () => candidateRows);
  insertedComments.length = 0;
  existingCommentsByIssue = {};
  issueStateByIssue = { 'iss-1': { status: 'awaiting_release', releaseBatchRunId: null } };
  selectFrom.mockClear();
  insertValues.mockClear();
  releasesAutomaticallyMock.mockReset();
  releasesAutomaticallyMock.mockResolvedValue(true);
  resolveReleaseGateMock.mockReset();
  resolveReleaseGateMock.mockResolvedValue('awaiting_release');
  loadReleaseRosterMock.mockReset();
  loadReleaseRosterMock.mockResolvedValue({ issues: [] });
  issuesWithUnearnedCriteriaMock.mockReset();
  issuesWithUnearnedCriteriaMock.mockResolvedValue([]);
  loadCreatedByMock.mockReset();
  loadCreatedByMock.mockResolvedValue('owner-1');
  cutWaitingReleaseMock.mockReset();
  cutWaitingReleaseMock.mockResolvedValue({
    status: 'success',
    output: 'cut 1 issue(s) as run run-1',
  });
});

describe('sweepAutomaticReleases — policy gate', () => {
  it('touches nothing on a project whose autoProdDeploy is not true', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    releasesAutomaticallyMock.mockResolvedValueOnce(false);

    const result = await sweepAutomaticReleases();

    expect(loadReleaseRosterMock).not.toHaveBeenCalled();
    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(result).toEqual({ projectsCut: 0, issuesCut: 0, issuesExcluded: 0 });
  });

  it('touches nothing on a project whose release gate does not resolve', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    resolveReleaseGateMock.mockResolvedValueOnce(null);

    await sweepAutomaticReleases();

    expect(loadReleaseRosterMock).not.toHaveBeenCalled();
    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
  });

  it('touches nothing when the release gate lookup throws', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    resolveReleaseGateMock.mockRejectedValueOnce(new Error('RELEASE_TARGET_UNDECLARED'));

    await sweepAutomaticReleases();

    expect(loadReleaseRosterMock).not.toHaveBeenCalled();
  });
});

describe('sweepAutomaticReleases — the ISS-1139/ISS-1114 reproduction', () => {
  it('leaves an issue with an unearned criterion untouched — no cut, no comment', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1139', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [{ id: 'iss-1139', claimedByRunId: null }],
    });
    issuesWithUnearnedCriteriaMock.mockResolvedValueOnce(['iss-1139']);

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(insertedComments).toEqual([]);
    expect(result).toEqual({ projectsCut: 0, issuesCut: 0, issuesExcluded: 1 });
  });

  it('cuts only the earned issue in a mixed roster, leaving the unearned one out of the call', async () => {
    candidateRows = [
      candidateRow('proj-1', 'iss-1139', '2026-09-22T00:00:00Z'),
      candidateRow('proj-1', 'iss-earned', '2026-09-22T00:00:01Z'),
    ];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [
        { id: 'iss-1139', claimedByRunId: null },
        { id: 'iss-earned', claimedByRunId: null },
      ],
    });
    issuesWithUnearnedCriteriaMock.mockResolvedValueOnce(['iss-1139']);

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      userId: 'owner-1',
      issueIds: ['iss-earned'],
    });
    expect(result).toEqual({ projectsCut: 1, issuesCut: 1, issuesExcluded: 1 });
  });

  it('cuts nothing and calls cutWaitingRelease not at all when the roster is empty of unclaimed issues', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [{ id: 'iss-1', claimedByRunId: 'already-running' }],
    });

    await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
  });
});

describe('sweepAutomaticReleases — failure reporting', () => {
  it('names a genuine failure on every issue it would have released, once', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [{ id: 'iss-1', claimedByRunId: null }],
    });
    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'failed',
      output: 'the cut failed',
      error: 'advisory lock timeout',
    });

    await sweepAutomaticReleases();

    expect(insertedComments).toHaveLength(1);
    expect(insertedComments[0]?.issueId).toBe('iss-1');
    expect(insertedComments[0]?.body).toContain('advisory lock timeout');
    expect(insertedComments[0]?.body).toContain('not claimed, not moved');
  });

  it('never claims the issue is untouched when createReleaseBatch failed after claiming it', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [{ id: 'iss-1', claimedByRunId: null }],
    });
    issueStateByIssue = { 'iss-1': { status: 'releasing', releaseBatchRunId: 'run-9' } };
    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'failed',
      output: 'the cut failed',
      error: 'enqueue failed after claiming issues',
    });

    await sweepAutomaticReleases();

    expect(insertedComments).toHaveLength(1);
    expect(insertedComments[0]?.body).not.toContain('not claimed, not moved');
    expect(insertedComments[0]?.body).toContain('run-9');
  });

  it('does not repeat an identical failure comment on a later tick', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValue({ issues: [{ id: 'iss-1', claimedByRunId: null }] });
    cutWaitingReleaseMock.mockResolvedValue({
      status: 'failed',
      output: 'the cut failed',
      error: 'advisory lock timeout',
    });

    await sweepAutomaticReleases();
    const firstBody = insertedComments[0]?.body ?? '';
    existingCommentsByIssue = { 'iss-1': [firstBody] };
    insertedComments.length = 0;

    await sweepAutomaticReleases();

    expect(insertedComments).toEqual([]);
  });

  it('posts a new comment when the failure message changes', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValue({ issues: [{ id: 'iss-1', claimedByRunId: null }] });
    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'failed',
      output: 'the cut failed',
      error: 'advisory lock timeout',
    });
    await sweepAutomaticReleases();
    existingCommentsByIssue = { 'iss-1': [insertedComments[0]?.body ?? ''] };
    insertedComments.length = 0;

    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'failed',
      output: 'the cut failed',
      error: 'a completely different failure',
    });
    await sweepAutomaticReleases();

    expect(insertedComments).toHaveLength(1);
    expect(insertedComments[0]?.body).toContain('a completely different failure');
  });

  it('does not report a known operational blocker as a failure', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    loadReleaseRosterMock.mockResolvedValueOnce({
      issues: [{ id: 'iss-1', claimedByRunId: null }],
    });
    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'skipped',
      output: 'no cut this tick: no runner is online',
    });

    await sweepAutomaticReleases();

    expect(insertedComments).toEqual([]);
  });
});

describe('sweepAutomaticReleases — per-project fault isolation', () => {
  it('keeps sweeping other projects when one throws', async () => {
    candidateRows = [
      candidateRow('proj-bad', 'iss-bad', '2026-09-22T00:00:00Z'),
      candidateRow('proj-good', 'iss-good', '2026-09-22T00:00:01Z'),
    ];
    loadReleaseRosterMock.mockImplementation(async (projectId: string) => {
      if (projectId === 'proj-bad') throw new Error('boom');
      return { issues: [{ id: 'iss-good', claimedByRunId: null }] };
    });

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).toHaveBeenCalledWith({
      projectId: 'proj-good',
      userId: 'owner-1',
      issueIds: ['iss-good'],
    });
    expect(result.projectsCut).toBe(1);
  });
});
