/**
 * ISS-102 — MCP tool tests for `forge_pipeline_runs.list/.get/.pause/.resume/.cancel`.
 * Mirrors the mocking style of `forge-agent-sessions.test.ts` — drizzle chains
 * + `runs-control` stubs so the contract under test is "auth gating +
 * input/output shape", not the transition semantics (covered in
 * runs-control.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectGroupBy = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
  groupBy: selectGroupBy,
}));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const pauseSpy = vi.fn();
const resumeSpy = vi.fn();
const cancelSpy = vi.fn();
vi.mock('../../pipeline/runs-control.js', () => ({
  pausePipelineRun: (id: string) => pauseSpy(id),
  resumePipelineRun: (id: string) => resumeSpy(id),
  cancelPipelineRun: (id: string) => cancelSpy(id),
}));

const {
  forgePipelineRunsListTool,
  forgePipelineRunsGetTool,
  forgePipelineRunsPauseTool,
  forgePipelineRunsResumeTool,
  forgePipelineRunsCancelTool,
} = await import('./forge-pipeline-runs.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

const baseRun = {
  id: RUN_ID,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  kind: 'issue' as const,
  status: 'running' as const,
  currentStep: null,
  startedAt: new Date(),
  finishedAt: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectGroupBy.mockReset();
  pauseSpy.mockReset();
  resumeSpy.mockReset();
  cancelSpy.mockReset();
});

describe('forge_pipeline_runs.list', () => {
  it('returns runs filtered by issueId/status when device owner is member', async () => {
    const tool = forgePipelineRunsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]); // member check
    selectLimit.mockResolvedValueOnce([baseRun]); // runs query

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'running',
    })) as { runs: Array<{ id: string }> };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.id).toBe(RUN_ID);
  });

  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgePipelineRunsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ ownerId: 'other' }]);
    selectLimit.mockResolvedValueOnce([]);
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
      tokenId: '66666666-6666-4666-8666-666666666666',
      scopes: ['read', 'write'],
      projectIds,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

describe('forge_pipeline_runs.get', () => {
  it('returns the run plus a per-status jobCounts breakdown', async () => {
    const tool = forgePipelineRunsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseRun]); // run lookup
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]); // member check
    selectGroupBy.mockResolvedValueOnce([
      { status: 'queued', count: 1 },
      { status: 'dispatched', count: 1 },
      { status: 'running', count: 1 },
      { status: 'completed', count: 0 },
    ]);

    const result = (await tool.handler({ runId: RUN_ID })) as {
      run: { id: string };
      jobCounts: Record<string, number>;
    };

    expect(result.run.id).toBe(RUN_ID);
    expect(result.jobCounts).toMatchObject({ queued: 1, dispatched: 1, running: 1 });
  });

  it('throws NOT_FOUND for a missing run', async () => {
    const tool = forgePipelineRunsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ runId: RUN_ID })).rejects.toThrow(/NOT_FOUND/);
  });

  it('throws FORBIDDEN when the calling device is cross-project', async () => {
    const tool = forgePipelineRunsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseRun]);
    selectLimit.mockResolvedValueOnce([{ ownerId: 'other' }]);
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ runId: RUN_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  // ISS-150 review #1 re-review — PAT projectIds allowlist regression on
  // runId-resolved access.
  it('returns NOT_FOUND for a PAT when the run’s project is outside the allowlist', async () => {
    const tool = forgePipelineRunsGetTool(
      makePatCtx(['99999999-9999-4999-8999-999999999999']),
    );
    selectLimit.mockResolvedValueOnce([baseRun]);
    await expect(tool.handler({ runId: RUN_ID })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('forge_pipeline_runs.pause/.resume/.cancel', () => {
  function memberRunLookup() {
    selectLimit.mockResolvedValueOnce([baseRun]); // run lookup
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]); // member check
  }

  it('pause delegates to pausePipelineRun and returns the run', async () => {
    const tool = forgePipelineRunsPauseTool(makeDeviceCtx());
    memberRunLookup();
    pauseSpy.mockResolvedValueOnce({ ...baseRun, status: 'paused' });
    const result = (await tool.handler({ runId: RUN_ID })) as { run: { status: string } };
    expect(result.run.status).toBe('paused');
    expect(pauseSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('resume delegates to resumePipelineRun and returns the run', async () => {
    const tool = forgePipelineRunsResumeTool(makeDeviceCtx());
    memberRunLookup();
    resumeSpy.mockResolvedValueOnce({ ...baseRun, status: 'running' });
    const result = (await tool.handler({ runId: RUN_ID })) as { run: { status: string } };
    expect(result.run.status).toBe('running');
    expect(resumeSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('cancel returns the full side-effect summary', async () => {
    const tool = forgePipelineRunsCancelTool(makeDeviceCtx());
    memberRunLookup();
    cancelSpy.mockResolvedValueOnce({
      run: { ...baseRun, status: 'cancelled' },
      cancelledJobIds: ['j1', 'j2'],
      abortedSessionIds: ['s1'],
      deviceIdsNotified: ['d1'],
    });
    const result = (await tool.handler({ runId: RUN_ID })) as {
      run: { status: string };
      cancelledJobIds: string[];
      abortedSessionIds: string[];
    };
    expect(result.run.status).toBe('cancelled');
    expect(result.cancelledJobIds).toHaveLength(2);
    expect(result.abortedSessionIds).toEqual(['s1']);
  });

  it('cancel rejects a non-member device with FORBIDDEN', async () => {
    const tool = forgePipelineRunsCancelTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseRun]); // run lookup
    selectLimit.mockResolvedValueOnce([{ ownerId: 'other' }]);
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ runId: RUN_ID })).rejects.toThrow(/FORBIDDEN/);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('cancel returns NOT_FOUND for a PAT when the run’s project is outside the allowlist', async () => {
    const tool = forgePipelineRunsCancelTool(
      makePatCtx(['99999999-9999-4999-8999-999999999999']),
    );
    selectLimit.mockResolvedValueOnce([baseRun]);
    await expect(tool.handler({ runId: RUN_ID })).rejects.toThrow(/NOT_FOUND/);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
