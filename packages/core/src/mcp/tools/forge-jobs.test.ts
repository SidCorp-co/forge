import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

// ISS-442 C0 — the MCP cancel tool delegates to the shared cancelJob() helper.
// Mock it here so these tests cover only the MCP layer (writer gate, arg
// passthrough, JobCancelError → Error mapping); the helper's transactional
// behaviour is exercised through the REST path tests.
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

const { forgeJobsListTool, forgeJobsGetTool, forgeJobsEventsTool, forgeJobsCancelTool } =
  await import('./forge-jobs.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

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

describe('forge_jobs.list', () => {
  it('lists jobs scoped by project + filters when device owner is member', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    // assertDeviceOwnerIsMember → projects.ownerId match
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    // jobs query
    selectLimit.mockResolvedValueOnce([baseJobRow]);

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      status: 'queued',
      type: 'code',
      issueId: ISSUE_ID,
    })) as { jobs: Array<{ id: string }> };

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.id).toBe(JOB_ID);
  });

  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgeJobsListTool(fakeDevice);
    // effective-role lookup: caller has no role
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);

    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });
});

function makeDeviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function makePatCtx(projectIds: string[] | null) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: OWNER_ID,
      tokenId: '77777777-7777-4777-8777-777777777777',
      scopes: ['read', 'write'],
      projectIds,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

describe('forge_jobs.get', () => {
  it('returns the job + agentSessionId when device owner is member', async () => {
    const tool = forgeJobsGetTool(makeDeviceCtx());
    // load job
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    // membership
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

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

describe('forge_jobs.events', () => {
  it('returns paginated { items, lastSeq } with sinceSeq filter', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    // load job
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    // membership
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    // events query
    selectLimit.mockResolvedValueOnce([
      { id: 'e1', jobId: JOB_ID, ts: new Date(), kind: 'stdout', data: {}, seq: 5 },
      { id: 'e2', jobId: JOB_ID, ts: new Date(), kind: 'stdout', data: {}, seq: 7 },
    ]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 4 })) as {
      items: Array<{ seq: number }>;
      lastSeq: number;
    };
    expect(result.items).toHaveLength(2);
    expect(result.lastSeq).toBe(7);
  });

  it('returns lastSeq = sinceSeq when no items match', async () => {
    const tool = forgeJobsEventsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    selectLimit.mockResolvedValueOnce([]);

    const result = (await tool.handler({ jobId: JOB_ID, sinceSeq: 42 })) as {
      lastSeq: number;
    };
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
    selectLimit.mockResolvedValueOnce([baseJobRow]); // load job
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // writer gate
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
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
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
    // The tool never inspects pipeline_run status; cancelJob owns that (and has
    // no run guard). A writer cancel succeeds regardless of run state.
    const tool = forgeJobsCancelTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ ...baseJobRow, status: 'dispatched' }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
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
    selectLimit.mockResolvedValueOnce([baseJobRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    cancelJobMock.mockRejectedValueOnce(
      new JobCancelError('NOT_CANCELLABLE', 'job is not cancellable'),
    );

    await expect(tool.handler({ jobId: JOB_ID })).rejects.toThrow(/NOT_CANCELLABLE/);
  });
});
