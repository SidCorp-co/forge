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

/** The unclaimed `awaiting_release` rows a project's waiting read returns. */
let waitingIds: string[] = [];

const selectFrom = vi.fn((columns: Record<string, unknown>) => ({
  from: (_table: unknown) => ({
    where: () => {
      const rows =
        'status' in columns
          ? Object.entries(issueStateByIssue).map(([id, s]) => ({ id, ...s }))
          : Object.entries(existingCommentsByIssue).flatMap(([, bodies]) =>
              bodies.map((body) => ({ body })),
            );
      return Object.assign(Promise.resolve(rows), {
        orderBy: async () => waitingIds.map((id) => ({ id })),
      });
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

type Hold = { code: string; reason: string; owes: string; waitingFor: string };
/** Every hold written this tick, keyed by issue, with the author it was written as. */
let holds: Record<string, Hold & { authorId: string | null }> = {};
const clearedHolds: string[][] = [];
const clearedProjects: string[] = [];
const staleClears = vi.fn(async () => 0);
vi.mock('./release-hold.js', async () => {
  const actual = await vi.importActual<typeof import('./release-hold.js')>('./release-hold.js');
  return {
    ...actual,
    writeReleaseHolds: async (args: {
      issueIds: string[];
      holdFor: (id: string) => Hold;
      authorId: string | null;
    }) => {
      for (const id of args.issueIds) holds[id] = { ...args.holdFor(id), authorId: args.authorId };
      return { written: args.issueIds.length, unchanged: 0, skipped: 0 };
    },
    clearReleaseHolds: async (ids: string[]) => {
      clearedHolds.push([...ids]);
      return ids.length;
    },
    clearProjectReleaseHolds: async (projectId: string) => {
      clearedProjects.push(projectId);
      return 0;
    },
    clearStaleReleaseHolds: () => staleClears(),
  };
});

const projectAutoProdDeployMock = vi.fn(async (_projectId: string) => true);
vi.mock('./release-coolify.js', () => ({
  projectAutoProdDeploy: (projectId: string) => projectAutoProdDeployMock(projectId),
}));

const resolveReleaseGateMock = vi.fn(
  async (_projectId: string) => 'awaiting_release' as string | null,
);
class ReleaseTargetUndeclaredError extends Error {}
vi.mock('../release-batch/gate.js', () => ({
  RELEASE_GATE_STATUS: 'awaiting_release',
  ReleaseTargetUndeclaredError,
  resolveReleaseGate: (projectId: string) => resolveReleaseGateMock(projectId),
}));

interface UnearnedCriterion {
  criterion: number;
  verdict: string | null;
  standing: string | null;
  why: string;
}
interface CriteriaReport {
  issueId: string;
  unearned: UnearnedCriterion[];
}
const unearnedCriteriaReportsMock = vi.fn(
  async (ids: string[]): Promise<CriteriaReport[]> =>
    ids.map((id) => ({ issueId: id, unearned: [] })),
);
vi.mock('../issues/criteria-verdicts.js', () => ({
  unearnedCriteriaReports: (ids: string[]) => unearnedCriteriaReportsMock(ids),
}));

/** The report a sweep reads for a roster where `held` are the ones still owing a criterion. */
const reportsHolding = (all: string[], held: Record<string, UnearnedCriterion[]>) =>
  all.map((id) => ({ issueId: id, unearned: held[id] ?? [] }));

const SUPERSEDED: UnearnedCriterion = {
  criterion: 13,
  verdict: 'pass',
  standing: 'superseded',
  why: 'judged at dce6f354c727baa81c681f144cbadf30050eabfc, and this issue now stands at 06fa37c6dfbc841bd75c3898034a53a1529a9c74',
};

const loadCreatedByMock = vi.fn(async (_projectId: string) => 'owner-1' as string | undefined);
vi.mock('../schedules/release-batch-dispatch.js', () => ({
  loadCreatedBy: (projectId: string) => loadCreatedByMock(projectId),
}));

interface CutOutcome {
  status: 'success' | 'skipped' | 'failed';
  output: string;
  error?: string;
  code?: string;
  reasons?: string[];
  named?: string[];
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
// `named` defaults to what the real cut names: the oldest fifty it was handed (ISS-1127).
vi.mock('../schedules/release-batch-run.js', () => ({
  cutWaitingRelease: async (args: { projectId: string; userId: string; issueIds: string[] }) => ({
    named: args.issueIds.slice(0, 50),
    ...(await cutWaitingReleaseMock(args)),
  }),
}));

const loggerInfo = vi.fn();
const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    error: (...args: unknown[]) => loggerError(...args),
    warn: vi.fn(),
    info: (...args: unknown[]) => loggerInfo(...args),
  },
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
  projectAutoProdDeployMock.mockReset();
  projectAutoProdDeployMock.mockResolvedValue(true);
  resolveReleaseGateMock.mockReset();
  resolveReleaseGateMock.mockResolvedValue('awaiting_release');
  waitingIds = [];
  holds = {};
  clearedHolds.length = 0;
  clearedProjects.length = 0;
  staleClears.mockClear();
  loggerError.mockReset();
  unearnedCriteriaReportsMock.mockReset();
  unearnedCriteriaReportsMock.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ issueId: id, unearned: [] })),
  );
  loggerInfo.mockReset();
  loadCreatedByMock.mockReset();
  loadCreatedByMock.mockResolvedValue('owner-1');
  cutWaitingReleaseMock.mockReset();
  cutWaitingReleaseMock.mockResolvedValue({
    status: 'success',
    output: 'cut 1 issue(s) as run run-1',
  });
});

const NO_HOLDS = { projectsCut: 0, issuesCut: 0, issuesExcluded: 0, holdsWritten: 0 };

describe('sweepAutomaticReleases — policy gate', () => {
  it('cuts nothing, writes no hold and clears the project on a project that is not automatic', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    projectAutoProdDeployMock.mockResolvedValueOnce(false);

    const result = await sweepAutomaticReleases();

    expect(staleClears).toHaveBeenCalledTimes(1);
    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(holds).toEqual({});
    expect(clearedProjects).toEqual(['proj-1']);
    expect(result).toEqual(NO_HOLDS);
  });

  it('writes NO_RELEASE_GATE on every waiting row of a project that declares no release', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1', 'iss-2'];
    resolveReleaseGateMock.mockResolvedValueOnce(null);

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(holds['iss-1']?.code).toBe('NO_RELEASE_GATE');
    expect(holds['iss-2']?.code).toBe('NO_RELEASE_GATE');
    expect(result.holdsWritten).toBe(2);
  });

  it('writes RELEASE_TARGET_UNDECLARED, carrying the refusal, when there is nowhere to release onto', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    resolveReleaseGateMock.mockRejectedValueOnce(
      new ReleaseTargetUndeclaredError('RELEASE_TARGET_UNDECLARED: no live binding'),
    );

    await sweepAutomaticReleases();

    expect(holds['iss-1']).toMatchObject({
      code: 'RELEASE_TARGET_UNDECLARED',
      reason: 'RELEASE_TARGET_UNDECLARED: no live binding',
      owes: 'human',
    });
    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
  });

  it('writes RELEASE_GATE_UNREADABLE and logs the error when the gate read fails otherwise', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    resolveReleaseGateMock.mockRejectedValueOnce(new Error('connection terminated'));

    await sweepAutomaticReleases();

    expect(holds['iss-1']?.code).toBe('RELEASE_GATE_UNREADABLE');
    expect(holds['iss-1']?.reason).toContain('connection terminated');
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
      'release-sweep: the release gate could not be read',
    );
  });

  it('writes RELEASE_CRITERIA_UNREADABLE on every waiting row when the verdicts cannot be read', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1', 'iss-2'];
    unearnedCriteriaReportsMock.mockRejectedValueOnce(new Error('comments read timed out'));

    await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(holds['iss-2']?.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    expect(holds['iss-1']?.reason).toContain('comments read timed out');
  });
});

describe('sweepAutomaticReleases — the ISS-1139/ISS-1114 reproduction', () => {
  it('does not cut an issue with an unearned criterion, and writes why on it', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1139', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1139'];
    unearnedCriteriaReportsMock.mockResolvedValueOnce(
      reportsHolding(['iss-1139'], { 'iss-1139': [SUPERSEDED] }),
    );

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(insertedComments).toEqual([]);
    const held = holds['iss-1139'];
    expect(held?.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(held?.reason).toContain('criterion 13');
    expect(held?.reason).toContain('this issue now stands at');
    expect(held?.owes).toBe('agent');
    expect(holds['iss-1139']?.authorId).toBe('owner-1');
    expect(result).toEqual({ ...NO_HOLDS, issuesExcluded: 1, holdsWritten: 1 });
  });

  it('names the issue, the criterion and why it was not earned in the log as well', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1139', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1139'];
    unearnedCriteriaReportsMock.mockResolvedValueOnce(
      reportsHolding(['iss-1139'], {
        'iss-1139': [
          SUPERSEDED,
          { criterion: 4, verdict: null, standing: null, why: 'no verdict was recorded for it' },
        ],
      }),
    );

    await sweepAutomaticReleases();

    const held = loggerInfo.mock.calls.find(([, line]) =>
      String(line).includes('is held back on criterion'),
    );
    expect(held?.[1]).toContain('iss-1139');
    expect(held?.[1]).toContain('13, 4');
    expect(held?.[0]).toMatchObject({
      issueId: 'iss-1139',
      criteria: [
        { criterion: 13, verdict: 'pass', standing: 'superseded' },
        { criterion: 4, verdict: null, standing: null },
      ],
    });
    expect(holds['iss-1139']?.reason).toContain('criterion 4: no verdict was recorded for it');
  });

  it('cuts the earned issue, holds nothing and clears its hold', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-earned', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-earned'];

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      userId: 'owner-1',
      issueIds: ['iss-earned'],
    });
    expect(holds).toEqual({});
    expect(clearedHolds).toEqual([['iss-earned']]);
    expect(result).toEqual({ ...NO_HOLDS, projectsCut: 1, issuesCut: 1 });
  });

  it('cuts only the earned issue in a mixed roster and holds the other', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1139', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1139', 'iss-earned'];
    unearnedCriteriaReportsMock.mockResolvedValueOnce(
      reportsHolding(['iss-1139', 'iss-earned'], { 'iss-1139': [SUPERSEDED] }),
    );

    const result = await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      userId: 'owner-1',
      issueIds: ['iss-earned'],
    });
    expect(Object.keys(holds)).toEqual(['iss-1139']);
    expect(result).toEqual({ projectsCut: 1, issuesCut: 1, issuesExcluded: 1, holdsWritten: 1 });
  });

  it('does nothing for a project with no unclaimed waiting issue', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    await sweepAutomaticReleases();
    expect([cutWaitingReleaseMock.mock.calls.length, Object.keys(holds).length]).toEqual([0, 0]);
  });
});

describe('sweepAutomaticReleases — declined cuts', () => {
  it('writes RELEASE_NO_ACTOR with no author when the project has no owner', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    loadCreatedByMock.mockResolvedValueOnce(undefined);

    await sweepAutomaticReleases();

    expect(cutWaitingReleaseMock).not.toHaveBeenCalled();
    expect(holds['iss-1']?.code).toBe('RELEASE_NO_ACTOR');
    expect(holds['iss-1']?.authorId).toBeNull();
  });

  it.each([
    ['NO_RUNNER_ONLINE', 'human'],
    ['BATCH_IN_FLIGHT', 'agent'],
  ])('writes a %s refusal with every reason standing, owed by %s', async (code, owes) => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    const reasons = ['The first reason.', 'Also: the probes are undeclared.'];
    cutWaitingReleaseMock.mockResolvedValueOnce({ status: 'skipped', output: 'x', code, reasons });
    await sweepAutomaticReleases();
    expect(insertedComments).toEqual([]);
    expect(holds['iss-1']).toMatchObject({ code, owes });
    expect(holds['iss-1']?.reason).toContain('The first reason. Also: the probes are undeclared.');
  });

  it('writes RELEASE_CUT_FAILED on an untouched row when the cut fails, with no second comment', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    cutWaitingReleaseMock.mockResolvedValueOnce({
      status: 'failed',
      output: 'the cut failed',
      error: 'advisory lock timeout',
      reasons: ['advisory lock timeout'],
    });

    await sweepAutomaticReleases();

    expect(insertedComments).toEqual([]);
    expect(holds['iss-1']?.code).toBe('RELEASE_CUT_FAILED');
    expect(holds['iss-1']?.reason).toContain('advisory lock timeout');
    expect(holds['iss-1']?.reason).toContain('not claimed, not moved');
  });

  it('never claims a claimed issue is untouched, and does not repeat that comment', async () => {
    candidateRows = [candidateRow('proj-1', 'iss-1', '2026-09-22T00:00:00Z')];
    waitingIds = ['iss-1'];
    issueStateByIssue = { 'iss-1': { status: 'releasing', releaseBatchRunId: 'run-9' } };
    const error = 'enqueue failed after claiming issues';
    cutWaitingReleaseMock.mockResolvedValue({ status: 'failed', output: 'x', error });

    await sweepAutomaticReleases();
    expect(insertedComments).toHaveLength(1);
    expect(insertedComments[0]?.body).not.toContain('not claimed, not moved');
    expect(insertedComments[0]?.body).toContain('run-9');
    expect(holds['iss-1']).toBeUndefined();

    existingCommentsByIssue = { 'iss-1': [insertedComments[0]?.body ?? ''] };
    insertedComments.length = 0;
    await sweepAutomaticReleases();
    expect(insertedComments).toEqual([]);
  });
});

describe('sweepAutomaticReleases — one release carries the oldest fifty (ISS-1127)', () => {
  const waiting = Array.from({ length: 75 }, (_, i) => `iss-${i}`);
  beforeEach(() => {
    candidateRows = [candidateRow('proj-1', 'iss-0', '2026-09-22T00:00:00Z')];
    waitingIds = waiting;
    issueStateByIssue = Object.fromEntries(
      waiting.map((id) => [id, { status: 'awaiting_release', releaseBatchRunId: null }]),
    );
  });

  it('counts and clears only the fifty cut, and queues the tail behind them', async () => {
    const result = await sweepAutomaticReleases();
    expect(result.issuesCut).toBe(50);
    expect(clearedHolds).toEqual([waiting.slice(0, 50)]);
    expect(Object.keys(holds).sort()).toEqual(waiting.slice(50).sort());
    expect(holds['iss-74']).toMatchObject({ code: 'RELEASE_QUEUED_BEHIND', owes: 'agent' });
  });

  it('writes a failure only on the fifty the cut named, and the tail stays queued', async () => {
    cutWaitingReleaseMock.mockResolvedValueOnce({ status: 'failed', output: 'x', error: 'lock' });
    await sweepAutomaticReleases();
    expect(holds['iss-49']?.code).toBe('RELEASE_CUT_FAILED');
    expect(holds['iss-50']?.code).toBe('RELEASE_QUEUED_BEHIND');
  });
});

describe('sweepAutomaticReleases — per-project fault isolation', () => {
  it('keeps sweeping other projects when one throws', async () => {
    candidateRows = [
      candidateRow('proj-bad', 'iss-bad', '2026-09-22T00:00:00Z'),
      candidateRow('proj-good', 'iss-good', '2026-09-22T00:00:01Z'),
    ];
    waitingIds = ['iss-good'];
    projectAutoProdDeployMock.mockImplementation(async (projectId: string) => {
      if (projectId === 'proj-bad') throw new Error('boom');
      return true;
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
