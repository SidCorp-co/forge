import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const resultQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeThenable(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
    innerJoin: () => p,
    leftJoin: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    then: (resolve: (v: unknown) => void) => resolve(resultQueue.shift() ?? []),
  };
  return p;
}

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => makeThenable()) },
}));

const tryDispatchSpy = vi.fn();
const resolveRunSpy = vi.fn();
const dispatchDirectSpy = vi.fn();
const isIssueAtReleaseStageSpy = vi.fn();
vi.mock('../../pipeline/release-coolify.js', () => ({
  tryDispatchCoolifyRelease: (a: unknown) => tryDispatchSpy(a),
  resolveLatestIssueRunId: (a: unknown) => resolveRunSpy(a),
  dispatchCoolifyDeployDirect: (a: unknown) => dispatchDirectSpy(a),
  isIssueAtReleaseStage: (a: unknown) => isIssueAtReleaseStageSpy(a),
}));

const findLastOutboundSpy = vi.fn(),
  findLastOutboundForTargetSpy = vi.fn();
const fetchDeploymentLogsSpy = vi.fn(),
  fetchRuntimeLogsSpy = vi.fn();
vi.mock('../../integrations/coolify/log-fetch.js', () => ({
  fetchCoolifyDeploymentLogs: (...a: unknown[]) => fetchDeploymentLogsSpy(...a),
  fetchCoolifyRuntimeLogs: (...a: unknown[]) => fetchRuntimeLogsSpy(...a),
}));
vi.mock('../../integrations/deliveries.js', () => ({
  findLastOutbound: (a: unknown) => findLastOutboundSpy(a),
  findLastOutboundForTarget: (...a: unknown[]) => findLastOutboundForTargetSpy(...(a as [])),
}));

const { forgeCoolifyDeployTool } = await import('./forge-coolify-deploy.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const STAGING_INT = 'a1111111-1111-4111-8111-111111111111';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

function makeDeviceCtx() {
  return {
    principal: fakePrincipal,
    projectSlug: null,
  };
}

function pushMemberOk() {
  resultQueue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
}

function pair(
  id: string,
  environment: string,
  opts: {
    config?: Record<string, unknown>;
    lastHealthStatus?: string | null;
    breakerOpenedAt?: Date | null;
  } = {},
) {
  const base = { id, provider: 'coolify', active: true };
  return {
    binding: { ...base, environment, projectId: PROJECT_ID, config: {} },
    connection: {
      ...base,
      config: opts.config ?? {},
      lastHealthStatus: opts.lastHealthStatus ?? null,
      breakerOpenedAt: opts.breakerOpenedAt ?? null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  tryDispatchSpy.mockReset();
  resolveRunSpy.mockReset();
  dispatchDirectSpy.mockReset();
  isIssueAtReleaseStageSpy.mockReset();
  findLastOutboundSpy.mockReset();
  findLastOutboundForTargetSpy.mockReset();
  fetchDeploymentLogsSpy.mockReset();
  fetchRuntimeLogsSpy.mockReset();
});

describe('forge_coolify_deploy → list', () => {
  it('maps active integrations including breakerOpen + targets', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([
      pair(STAGING_INT, 'staging', {
        config: { targets: [{ id: 't-be', label: 'Backend', resourceUuid: 'res-staging' }] },
        lastHealthStatus: 'ok',
      }),
      pair(PROD_INT, 'prod', { breakerOpenedAt: new Date() }),
    ]);

    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      integrations: Array<{
        id: string;
        environment: string;
        targets: Array<{ id: string; label: string; resourceUuid: string }>;
        breakerOpen: boolean;
      }>;
    };

    expect(result.integrations).toHaveLength(2);
    expect(result.integrations[0]).toMatchObject({
      id: STAGING_INT,
      environment: 'staging',
      targets: [{ id: 't-be', label: 'Backend', resourceUuid: 'res-staging' }],
      breakerOpen: false,
    });
    expect(result.integrations[1]).toMatchObject({
      environment: 'prod',
      targets: [],
      breakerOpen: true,
    });
  });

  it('returns an empty array when no Coolify is configured', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([]);
    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      integrations: unknown[];
    };
    expect(result.integrations).toEqual([]);
  });

  it('rejects a non-member as not-found (existence-hiding)', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    resultQueue.push([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // no effective role
    await expect(tool.handler({ action: 'list', projectId: PROJECT_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });
});

describe('forge_coolify_deploy → deploy', () => {
  it('without issueId, single active integration → run-less deploy via dispatchCoolifyDeployDirect', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([pair(STAGING_INT, 'staging')]); // single active integration
    dispatchDirectSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    const result = (await tool.handler({ action: 'deploy', projectId: PROJECT_ID })) as {
      dispatched: boolean;
      integrationIds: string[];
    };

    expect(dispatchDirectSpy).toHaveBeenCalledTimes(1);
    expect(dispatchDirectSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      integrationId: STAGING_INT,
    });
    expect(tryDispatchSpy).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(true);
    expect(result.integrationIds).toEqual([STAGING_INT]);
  });

  it('without issueId, multiple active integrations and no integrationId → BAD_REQUEST ambiguous', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([pair(STAGING_INT, 'staging'), pair(PROD_INT, 'prod')]);

    await expect(tool.handler({ action: 'deploy', projectId: PROJECT_ID })).rejects.toThrow(
      /multiple active Coolify integrations/,
    );
    expect(dispatchDirectSpy).not.toHaveBeenCalled();
    expect(tryDispatchSpy).not.toHaveBeenCalled();
  });

  it('without issueId, explicit integrationId picks that integration', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([pair(STAGING_INT, 'staging'), pair(PROD_INT, 'prod')]);
    dispatchDirectSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    const result = (await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      integrationId: STAGING_INT,
    })) as { dispatched: boolean; integrationIds: string[] };

    expect(dispatchDirectSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      integrationId: STAGING_INT,
    });
    expect(result.dispatched).toBe(true);
  });

  it('delegates a staging deploy to tryDispatchCoolifyRelease and passes the outcome through', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    isIssueAtReleaseStageSpy.mockResolvedValueOnce(false);
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    const result = (await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { dispatched: boolean; integrationIds: string[] };

    expect(tryDispatchSpy).toHaveBeenCalledTimes(1);
    expect(tryDispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
      integrationId: null,
      allowProd: false,
    });
    expect(result.dispatched).toBe(true);
    expect(result.integrationIds).toEqual([STAGING_INT]);
  });

  it('returns reason:no-run without dispatching when the issue has no run', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce(null);

    const result = (await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { dispatched: boolean; reason: string };

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('no-run');
    expect(tryDispatchSpy).not.toHaveBeenCalled();
    expect(isIssueAtReleaseStageSpy).not.toHaveBeenCalled();
  });

  it('passes the prod human-confirm gate through (pendingHumanConfirm, no dispatch)', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    isIssueAtReleaseStageSpy.mockResolvedValueOnce(true);
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: false,
      pendingHumanConfirm: true,
      integrationIds: [PROD_INT],
      reason: 'awaiting-prod-confirm',
    });

    const result = (await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { dispatched: boolean; pendingHumanConfirm: boolean; reason: string };

    expect(result.dispatched).toBe(false);
    expect(result.pendingHumanConfirm).toBe(true);
    expect(result.reason).toBe('awaiting-prod-confirm');
  });

  it('issueId + explicit staging integrationId at a pre-release status → hard filter, prod excluded', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    isIssueAtReleaseStageSpy.mockResolvedValueOnce(false);
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      integrationId: STAGING_INT,
    });

    expect(tryDispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
      integrationId: STAGING_INT,
      allowProd: false,
    });
  });

  it('issueId-only at a pre-release status → allowProd:false, integrationId:null', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    isIssueAtReleaseStageSpy.mockResolvedValueOnce(false);
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    await tool.handler({ action: 'deploy', projectId: PROJECT_ID, issueId: ISSUE_ID });

    expect(tryDispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
      integrationId: null,
      allowProd: false,
    });
  });

  it('issueId-only at released status → allowProd:true', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    isIssueAtReleaseStageSpy.mockResolvedValueOnce(true);
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT, PROD_INT],
    });

    await tool.handler({ action: 'deploy', projectId: PROJECT_ID, issueId: ISSUE_ID });

    expect(tryDispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
      integrationId: null,
      allowProd: true,
    });
  });
});

describe('forge_coolify_deploy → logs', () => {
  it('passes lines to deployment-log reads and returns their freshness metadata', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    const integration = pair(STAGING_INT, 'staging');
    resultQueue.push([integration]);
    findLastOutboundSpy.mockResolvedValueOnce({
      response: { deployment_uuid: 'dep-1' },
    });
    fetchDeploymentLogsSpy.mockResolvedValueOnce({
      deploymentUuid: 'dep-1',
      status: 'running',
      commit: null,
      logs: 'step 1',
      truncated: false,
      fetchedAt: '2026-08-27T00:00:00.000Z',
      logsDigest: 'deadbeefcafe',
    });

    const result = await tool.handler({
      action: 'logs',
      projectId: PROJECT_ID,
      lines: 3,
    });

    expect(fetchDeploymentLogsSpy).toHaveBeenCalledWith(integration, 'dep-1', 3);
    expect(result).toMatchObject({
      integrationId: STAGING_INT,
      fetchedAt: '2026-08-27T00:00:00.000Z',
      logsDigest: 'deadbeefcafe',
    });
  });

  it('passes lines to runtime-log reads and returns their freshness metadata', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    const integration = pair(STAGING_INT, 'staging', {
      config: { targets: [{ id: 'target-1', label: 'Core', resourceUuid: 'app-1' }] },
    });
    resultQueue.push([integration]);
    fetchRuntimeLogsSpy.mockResolvedValueOnce({
      resourceUuid: 'app-1',
      logs: 'ready',
      truncated: false,
      fetchedAt: '2026-08-27T00:00:00.000Z',
      logsDigest: 'facefeedcafe',
    });

    const result = await tool.handler({
      action: 'runtime-logs',
      projectId: PROJECT_ID,
      lines: 7,
    });

    expect(fetchRuntimeLogsSpy).toHaveBeenCalledWith(integration, 'app-1', 7);
    expect(result).toMatchObject({
      integrationId: STAGING_INT,
      fetchedAt: '2026-08-27T00:00:00.000Z',
      logsDigest: 'facefeedcafe',
    });
  });
});

describe('forge_coolify_deploy → status', () => {
  it('returns the latest outbound delivery per TARGET of each active integration', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([
      pair(STAGING_INT, 'staging', {
        config: {
          targets: [
            { id: 't-be', label: 'Backend', resourceUuid: 'res-be' },
            { id: 't-fe', label: 'Frontend', resourceUuid: 'res-fe' },
          ],
        },
        lastHealthStatus: 'ok',
      }),
    ]);
    findLastOutboundForTargetSpy.mockImplementation(async (_bid: string, targetId: string) => ({
      status: 'ok',
      response: { deployment_uuid: `dep-${targetId}` },
      createdAt: new Date('2026-05-27T00:00:00Z'),
    }));

    const result = (await tool.handler({ action: 'status', projectId: PROJECT_ID })) as {
      deliveries: Array<{
        integrationId: string;
        targetId: string | null;
        targetLabel: string | null;
        deploymentUuid: string | null;
        status: string;
      }>;
    };

    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationId: STAGING_INT,
          targetId: 't-be',
          targetLabel: 'Backend',
          deploymentUuid: 'dep-t-be',
          status: 'ok',
        }),
        expect.objectContaining({
          targetId: 't-fe',
          targetLabel: 'Frontend',
          deploymentUuid: 'dep-t-fe',
        }),
      ]),
    );
  });
});
