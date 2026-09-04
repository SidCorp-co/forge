import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDevice } from '../fake-device.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const selectSpy = vi.fn(() => ({ from: selectFrom }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: selectSpy,
  },
}));

// cm:edge contract -> packages/core/src/jobs/queued-gates.ts — these stubs must keep the real return SHAPES (a Map for the batch, a DispatchBarrier for the single job); dispatch-gates.test.ts owns whether the gate reasons themselves are right, this file only covers the MCP layer attaching them
const gateReasonsMock = vi.fn(async (_projectId: string) => new Map<string, string>());
const assertDispatchableMock = vi.fn(async (_jobId: string) => ({ ok: true }) as unknown);
vi.mock('../../jobs/queued-gates.js', () => ({
  gateReasonsForQueuedJobs: (projectId: string) => gateReasonsMock(projectId),
  assertDispatchable: (jobId: string) => assertDispatchableMock(jobId),
}));

const cancelJobMock = vi.fn();
class JobCancelError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_CANCELLABLE',
    message: string,
  ) {
    super(message);
    this.name = 'JobCancelError';
  }
}
vi.mock('../../jobs/cancel-job.js', () => ({
  cancelJob: (...args: unknown[]) => cancelJobMock(...args),
  JobCancelError,
}));

const resumeJobMock = vi.fn();
class JobResumeError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'NOT_HELD',
    message: string,
  ) {
    super(message);
    this.name = 'JobResumeError';
  }
}
vi.mock('../../jobs/resume-job.js', () => ({
  resumeHeldJob: (...args: unknown[]) => resumeJobMock(...args),
  JobResumeError,
}));

const {
  forgeJobsListTool,
  forgeJobsGetTool,
  forgeJobsEventsTool,
  forgeJobsCancelTool,
  forgeJobsResumeTool,
} = await import('./forge-jobs.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID2 = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakeDevice = makeFakeDevice(DEVICE_ID, OWNER_ID);

const baseJobRow = {
  id: JOB_ID,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  deviceId: null,
  runnerId: null,
  createdBy: OWNER_ID,
  type: 'code' as const,
  payload: {},
  status: 'queued' as const,
  queuedAt: new Date(),
  dispatchedAt: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  error: null,
  modelTier: null,
  attempts: 1,
  maxAttempts: 3,
  cancellationRequested: false,
  retryOf: null,
  agentSessionId: '66666666-6666-4666-8666-666666666666',
  failureKind: null,
  failureReason: null,
  failureMeta: null,
  classifierVersion: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

type JobsPage = { jobs: Array<{ id?: string; gateReason?: string | null }> };
const mockMember = () =>
  selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
const mockMemberThenJobs = (rows: unknown[]) => {
  mockMember();
  selectLimit.mockResolvedValueOnce(rows);
};
const mockJobThenMember = (over: Record<string, unknown> = {}) => {
  selectLimit.mockResolvedValueOnce([{ ...baseJobRow, ...over }]);
  mockMember();
};

describe('forge_jobs.list', () => {
  it('lists jobs scoped by project + filters when device owner is member', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([baseJobRow]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      status: 'queued',
      type: 'code',
      issueId: ISSUE_ID,
    })) as JobsPage;

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.id).toBe(JOB_ID);
  });

  // cm:guard the gate reason must reach the CALLER, not just exist server-side — `queued` is the status of a job about to run AND of one blocked for weeks, and every diagnosis of the latter before this went through a hand-written database script
  it('attaches gateReason to queued rows', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([baseJobRow]);
    gateReasonsMock.mockResolvedValueOnce(new Map([[JOB_ID, 'blocked_by']]));

    const result = (await tool.handler({ projectId: PROJECT_ID })) as JobsPage;

    expect(gateReasonsMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(result.jobs[0]?.gateReason).toBe('blocked_by');
  });

  it('reports gateReason null for a queued job that is merely awaiting its turn', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([baseJobRow]);
    gateReasonsMock.mockResolvedValueOnce(new Map());

    const result = (await tool.handler({ projectId: PROJECT_ID })) as JobsPage;

    expect(result.jobs[0]?.gateReason).toBeNull();
  });

  // cm:guard skip the gate query when nothing is queued — a terminal-only page must not pay for a scan whose every answer would be omitted anyway
  it('does not query gates when no row is queued', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([{ ...baseJobRow, status: 'done' as const }]);

    const result = (await tool.handler({ projectId: PROJECT_ID })) as JobsPage;

    expect(gateReasonsMock).not.toHaveBeenCalled();
    expect(result.jobs[0]).not.toHaveProperty('gateReason');
  });

  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);

    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('projects a body-free column set (no payload/promptBlocks/failureMeta/userPromptSnapshot/error)', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([baseJobRow]);

    await tool.handler({ projectId: PROJECT_ID });

    const keys = Object.keys((selectSpy.mock.calls.at(-1) as unknown[])?.[0] as object);
    expect(keys).toEqual(expect.arrayContaining(['id', 'type', 'status', 'issueId']));
    for (const heavy of ['payload', 'promptBlocks', 'failureMeta', 'userPromptSnapshot', 'error']) {
      expect(keys).not.toContain(heavy);
    }
  });

  it('caps the total response size and flags truncation for a large list', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMember();
    const fatRows = Array.from({ length: 200 }, (_, i) => ({
      ...baseJobRow,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      failureReason: `transient runner failover after dispatch attempt ${i} (row padding to a realistic width)`,
    }));
    selectLimit.mockResolvedValueOnce(fatRows);

    const result = (await tool.handler({ projectId: PROJECT_ID, limit: 200 })) as {
      jobs: Array<{ id: string }>;
      truncated?: boolean;
      returned?: number;
      limit?: number;
    };

    expect(result.truncated).toBe(true);
    expect(result.jobs.length).toBeLessThan(200);
    expect(result.returned).toBe(result.jobs.length);
    expect(result.limit).toBe(200);
    expect(JSON.stringify(result).length).toBeLessThan(45_000);
    expect(result.jobs[0]?.id).toBe(fatRows[0]?.id);
  });

  it('returns the plain { jobs } shape when under the size budget', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    mockMemberThenJobs([baseJobRow, { ...baseJobRow, id: JOB_ID2 }]);

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      jobs: Array<{ id: string }>;
      truncated?: boolean;
    };

    expect(result.jobs).toHaveLength(2);
    expect(result.truncated).toBeUndefined();
  });
});

function makeDeviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

const makePatCtx = (projectIds: string[] | null) => ({
  principal: {
    kind: 'pat' as const,
    agency: 'human' as const,
    userId: OWNER_ID,
    tokenId: '77777777-7777-4777-8777-777777777777',
    scopes: ['read', 'write'],
    projectIds,
    boundProjectId: null,
  },
  device: fakeDevice,
  projectSlug: null,
});

describe('forge_jobs.get', () => {
  it('returns the job + agentSessionId when device owner is member', async () => {
    const tool = forgeJobsGetTool(makeDeviceCtx());
    mockJobThenMember();

    const result = (await tool.handler({ jobId: JOB_ID })) as {
      job: { id: string; agentSessionId: string };
    };
    expect(result.job.id).toBe(JOB_ID);
    expect(result.job.agentSessionId).toBe('66666666-6666-4666-8666-666666666666');
  });

  it('throws NOT_FOUND for missing job', async () => {
    const tool = forgeJobsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
  });

  it('throws FORBIDDEN cross-project', async () => {
    const tool = forgeJobsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ ...baseJobRow, projectId: OTHER_PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // not a member
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  // ISS-150 review #1 re-review — PAT projectIds allowlist regression on
  // jobId-resolved access.
  it('returns NOT_FOUND for a PAT when the job’s project is outside the allowlist', async () => {
    const tool = forgeJobsGetTool(makePatCtx([OTHER_PROJECT_ID]));
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
  });
});

type EventsPage = {
  items: Array<{ seq: number; data?: unknown }>;
  lastSeq: number;
  returned?: number;
  hasMore?: boolean;
};
const event = (seq: number, data: unknown = {}) => ({
  id: `e${seq}`,
  jobId: JOB_ID,
  ts: new Date(),
  kind: 'stdout',
  data,
  seq,
});

describe('forge_jobs.events', () => {
  it('returns paginated { items, lastSeq } with sinceSeq filter', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    mockJobThenMember();
    selectLimit.mockResolvedValueOnce([event(5), event(7)]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 4 })) as EventsPage;
    expect(result.items).toHaveLength(2);
    expect(result.lastSeq).toBe(7);
  });

  // cm:guard an event whose own data exceeds the response budget must be ELIDED, never dropped — dropping it left lastSeq at the caller's own sinceSeq while the notice told them to re-call with it, so the replay looped on that one event forever
  it('elides an oversized event payload rather than wedging the cursor', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    mockJobThenMember();
    selectLimit.mockResolvedValueOnce([event(5, { blob: 'x'.repeat(50_000) })]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 4 })) as EventsPage;
    expect(result).toMatchObject({ lastSeq: 5, returned: 1, hasMore: false });
    expect(result.items[0]?.data).toEqual({ omitted: true, bytes: 50_011 });
    expect(JSON.stringify(result).length).toBeLessThan(38_000);
  });

  // cm:guard the size trim sheds the NEWEST events on this cursor-paginated surface — shedding the oldest moves lastSeq past pages the caller never received, and nothing ever replays them
  it('keeps the earliest events when the page as a whole is too big', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    mockJobThenMember();
    const page = Array.from({ length: 20 }, (_, i) => event(i + 1, { blob: 'x'.repeat(7_000) }));
    selectLimit.mockResolvedValueOnce(page);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 0 })) as EventsPage;
    expect(result.items[0]?.seq).toBe(1);
    expect(result.lastSeq).toBe(result.items.at(-1)?.seq);
    expect(result.hasMore).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(38_000);
  });

  // cm:guard lastSeq must land on the LAST RETURNED event, never on the over-fetched probe row — the probe exists only to prove hasMore, and letting it set the cursor skips that event forever because nothing replays it
  it('over-fetches by one and leaves the cursor on the last event it returned', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    mockJobThenMember();
    selectLimit.mockResolvedValueOnce([event(5), event(6), event(7), event(8)]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 4, limit: 3 })) as EventsPage;
    expect(selectLimit).toHaveBeenLastCalledWith(4);
    expect(result).toMatchObject({ returned: 3, hasMore: true });
    expect(result.items.map((i) => i.seq)).toEqual([5, 6, 7]);
    expect(result.lastSeq).toBe(7);
  });

  it('returns lastSeq = sinceSeq when no items match', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    mockJobThenMember();
    selectLimit.mockResolvedValueOnce([]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 42 })) as EventsPage;
    expect(result.lastSeq).toBe(42);
  });

  it('throws NOT_FOUND for missing job', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
  });

  it('throws FORBIDDEN cross-project', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ ...baseJobRow, projectId: OTHER_PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // not a member
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  it('returns NOT_FOUND for a PAT when the job’s project is outside the allowlist', async () => {
    const tool = forgeJobsEventsTool(makePatCtx([OTHER_PROJECT_ID]));
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('forge_jobs.cancel', () => {
  it('cancels a queued job for a writer and passes actor + reason + source', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    mockJobThenMember();
    cancelJobMock.mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'cancelled',
      cancellationRequested: true,
    });

    const result = (await tool.handler({ jobId: JOB_ID, reason: 'stuck ghost job' })) as {
      jobId: string;
      status: string;
      cancellationRequested: boolean;
    };

    expect(result.status).toBe('cancelled');
    expect(result.cancellationRequested).toBe(true);
    expect(cancelJobMock).toHaveBeenCalledWith(JOB_ID, {
      actorUserId: OWNER_ID,
      reason: 'stuck ghost job',
      source: 'mcp',
    });
  });

  it('defaults the reason when none is supplied', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    mockJobThenMember();
    cancelJobMock.mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'cancelled',
      cancellationRequested: true,
    });

    await tool.handler({ jobId: JOB_ID });

    expect(cancelJobMock).toHaveBeenCalledWith(
      JOB_ID,
      expect.objectContaining({ reason: 'manual cancel (MCP)', source: 'mcp' }),
    );
  });

  it('cancels a queued job whose project membership holds even with a terminal run (no run guard)', async () => {
    // cm:edge contract -> packages/core/src/jobs/cancel-job.ts — this tool never reads pipeline_run status; cancel-job.ts owns whether a run state may block a cancel, and today it has no such guard, so a writer cancel succeeds regardless of run state
    const tool = forgeJobsCancelTool(makeDeviceCtx());
    mockJobThenMember({ status: 'dispatched' });
    cancelJobMock.mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'dispatched',
      cancellationRequested: true,
    });

    const result = (await tool.handler({ jobId: JOB_ID })) as { cancellationRequested: boolean };
    expect(result.cancellationRequested).toBe(true);
  });

  it('rejects a viewer with FORBIDDEN before calling cancelJob', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'viewer', orgRole: null }]);

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/FORBIDDEN/);
    expect(cancelJobMock).not.toHaveBeenCalled();
  });

  it('rejects a non-member with NOT_FOUND before calling cancelJob', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
    expect(cancelJobMock).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing job', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
    expect(cancelJobMock).not.toHaveBeenCalled();
  });

  it('maps a NOT_CANCELLABLE JobCancelError to an Error result', async () => {
    const tool = forgeJobsCancelTool(makePatCtx(null));
    mockJobThenMember();
    cancelJobMock.mockRejectedValueOnce(
      new JobCancelError('NOT_CANCELLABLE', 'job is not cancellable'),
    );

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_CANCELLABLE/);
  });
});

describe('forge_jobs.resume', () => {
  it('resumes for a writer and passes actor + reason + source', async () => {
    const tool = forgeJobsResumeTool(makePatCtx(null));
    mockJobThenMember({ status: 'held' });
    resumeJobMock.mockResolvedValueOnce({
      jobId: JOB_ID,
      status: 'queued',
      heldReason: 'non_retryable_terminal',
    });

    const result = (await tool.handler({ jobId: JOB_ID, reason: 'repo re-cloned' })) as {
      status: string;
      heldReason: string;
    };

    expect(result).toEqual({
      jobId: JOB_ID,
      status: 'queued',
      heldReason: 'non_retryable_terminal',
    });
    expect(resumeJobMock).toHaveBeenCalledWith(JOB_ID, {
      actorUserId: OWNER_ID,
      reason: 'repo re-cloned',
      source: 'mcp',
    });
  });

  it('defaults the reason when none is supplied', async () => {
    const tool = forgeJobsResumeTool(makePatCtx(null));
    mockJobThenMember({ status: 'held' });
    resumeJobMock.mockResolvedValueOnce({ jobId: JOB_ID, status: 'queued', heldReason: null });

    await tool.handler({ jobId: JOB_ID });

    expect(resumeJobMock).toHaveBeenCalledWith(
      JOB_ID,
      expect.objectContaining({ reason: 'manual resume (MCP)', source: 'mcp' }),
    );
  });

  // cm:guard writer-gated, same as cancel — a resume moves a job, and a viewer who can restart a step on someone else's project can spend their runner budget
  it('rejects a viewer with FORBIDDEN before calling the service', async () => {
    const tool = forgeJobsResumeTool(makePatCtx(null));
    selectLimit.mockResolvedValueOnce([{ ...baseJobRow, status: 'held' }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'viewer', orgRole: null }]);

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/FORBIDDEN/);
    expect(resumeJobMock).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing job', async () => {
    const tool = forgeJobsResumeTool(makePatCtx(null));
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_FOUND/);
    expect(resumeJobMock).not.toHaveBeenCalled();
  });

  it('maps a NOT_HELD JobResumeError to an Error result', async () => {
    const tool = forgeJobsResumeTool(makePatCtx(null));
    mockJobThenMember();
    resumeJobMock.mockRejectedValueOnce(new JobResumeError('NOT_HELD', 'job is running, not held'));

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_HELD/);
  });
});
