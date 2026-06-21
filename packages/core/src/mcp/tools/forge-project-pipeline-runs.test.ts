/**
 * ISS-145 — Action-dispatcher tests for `forge_project_pipeline_runs`.
 *
 * Mirrors the per-action coverage in `forge-pipeline-runs.test.ts` (the
 * legacy-shim suite) but invokes the consolidated tool with the new
 * `{ action: '...', ... }` shape so we catch regressions in:
 *   - per-action required-field validation (BAD_REQUEST surface),
 *   - auth re-application inside each switch arm,
 *   - PAT cross-tenant guard for runId-resolved actions,
 *   - the dispatcher's pass-through to the same pure handlers used by the
 *     legacy shims.
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
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const selectSpy = vi.fn(() => ({ from: selectFrom }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: selectSpy,
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

const { forgeProjectPipelineRunsTool } = await import('./forge-project-pipeline-runs.js');

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
      boundProjectId: null,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectGroupBy.mockReset();
  pauseSpy.mockReset();
  resumeSpy.mockReset();
  cancelSpy.mockReset();
});

describe('forge_project_pipeline_runs (action=list)', () => {
  it('returns runs filtered by issueId/status when device owner is member', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    selectLimit.mockResolvedValueOnce([baseRun]); // runs query

    const result = (await tool.handler({
      action: 'list',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'running',
    })) as { runs: Array<{ id: string }> };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.id).toBe(RUN_ID);
  });

  it('rejects when projectId missing with BAD_REQUEST', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  // ISS-428 — list must project scalar columns only (no `metadata` jsonb) so a
  // large list stays under the MCP response token cap.
  it('projects scalar columns only and omits the metadata jsonb', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    selectLimit.mockResolvedValueOnce([baseRun]); // runs query

    await tool.handler({ action: 'list', projectId: PROJECT_ID });

    const lastCall = selectSpy.mock.calls.at(-1) as unknown[] | undefined;
    const projection = lastCall?.[0] as Record<string, unknown> | undefined;
    expect(projection).toBeDefined();
    const keys = Object.keys(projection ?? {});
    expect(keys).toContain('id');
    expect(keys).toContain('status');
    expect(keys).toContain('currentStep');
    expect(keys).not.toContain('metadata');
  });
});

describe('forge_project_pipeline_runs (action=get)', () => {
  it('returns the run plus jobCounts', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseRun]); // run lookup
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    selectGroupBy.mockResolvedValueOnce([
      { status: 'queued', count: 1 },
      { status: 'running', count: 2 },
    ]);

    const result = (await tool.handler({ action: 'get', runId: RUN_ID })) as {
      run: { id: string };
      jobCounts: Record<string, number>;
    };
    expect(result.run.id).toBe(RUN_ID);
    expect(result.jobCounts).toMatchObject({ queued: 1, running: 2 });
  });

  it('rejects missing runId with BAD_REQUEST', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    await expect(tool.handler({ action: 'get' })).rejects.toThrow(/BAD_REQUEST/);
  });

  // Acceptance criterion 8 — PAT for project A cannot run the action against
  // project B. The server-level allowlist gate fires before the handler; this
  // case bypasses that gate by calling the factory directly, exercising the
  // dispatcher's own `assertPrincipalIsMember` (NOT_FOUND surface for PAT).
  it('returns NOT_FOUND for a PAT outside the project allowlist', async () => {
    const tool = forgeProjectPipelineRunsTool(
      makePatCtx(['99999999-9999-4999-8999-999999999999']),
    );
    selectLimit.mockResolvedValueOnce([baseRun]);
    await expect(tool.handler({ action: 'get', runId: RUN_ID })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('forge_project_pipeline_runs (action=pause/resume/cancel)', () => {
  function memberRunLookup() {
    selectLimit.mockResolvedValueOnce([baseRun]); // run lookup
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
  }

  /** pause/resume/cancel re-check WRITER access on the run's project. */
  function writerCheck() {
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
  }

  it('pause delegates to the shared pure handler', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    memberRunLookup();
    writerCheck();
    pauseSpy.mockResolvedValueOnce({ ...baseRun, status: 'paused' });
    const result = (await tool.handler({ action: 'pause', runId: RUN_ID })) as {
      run: { status: string };
    };
    expect(result.run.status).toBe('paused');
    expect(pauseSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('resume delegates to the shared pure handler', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    memberRunLookup();
    writerCheck();
    resumeSpy.mockResolvedValueOnce({ ...baseRun, status: 'running' });
    const result = (await tool.handler({ action: 'resume', runId: RUN_ID })) as {
      run: { status: string };
    };
    expect(result.run.status).toBe('running');
    expect(resumeSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('cancel returns the side-effect summary', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    memberRunLookup();
    writerCheck();
    cancelSpy.mockResolvedValueOnce({
      run: { ...baseRun, status: 'cancelled' },
      cancelledJobIds: ['j1'],
      abortedSessionIds: [],
      deviceIdsNotified: [],
    });
    const result = (await tool.handler({ action: 'cancel', runId: RUN_ID })) as {
      run: { status: string };
      cancelledJobIds: string[];
    };
    expect(result.run.status).toBe('cancelled');
    expect(result.cancelledJobIds).toEqual(['j1']);
  });

  it('cancel rejects missing runId with BAD_REQUEST', async () => {
    const tool = forgeProjectPipelineRunsTool(makeDeviceCtx());
    await expect(tool.handler({ action: 'cancel' })).rejects.toThrow(/BAD_REQUEST/);
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});
