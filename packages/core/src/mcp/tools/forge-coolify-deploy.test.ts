/**
 * ISS-242 — MCP tool tests for `forge_coolify_deploy` (list/deploy/status).
 *
 * The contract under test is "auth gating + action routing + input/output
 * shape". The dispatch semantics + the manual/auto idempotency guard live in
 * `release-coolify.ts` and are covered in `release-coolify.test.ts`, so here we
 * mock `tryDispatchCoolifyRelease` / `resolveLatestIssueRunId` and assert the
 * tool delegates correctly and passes the outcome through unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// FIFO result queue: each awaited drizzle chain consumes the next entry, so
// tests just push results in call order (membership check first, then the
// integration query).
const resultQueue: unknown[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal chainable drizzle stub
function makeThenable(): any {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const p: any = {
    from: () => p,
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
vi.mock('../../pipeline/release-coolify.js', () => ({
  tryDispatchCoolifyRelease: (a: unknown) => tryDispatchSpy(a),
  resolveLatestIssueRunId: (a: unknown) => resolveRunSpy(a),
}));

const findLastOutboundSpy = vi.fn();
vi.mock('../../integrations/deliveries.js', () => ({
  findLastOutbound: (a: unknown) => findLastOutboundSpy(a),
}));

const { forgeCoolifyDeployTool } = await import('./forge-coolify-deploy.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const STAGING_INT = 'a1111111-1111-4111-8111-111111111111';
const PROD_INT = 'b2222222-2222-4222-8222-222222222222';

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

function makeDeviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

/** Push the single-row result `loadDeviceProjectRole` reads for an owner. */
function pushMemberOk() {
  resultQueue.push([{ ownerId: OWNER_ID }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resultQueue.length = 0;
  tryDispatchSpy.mockReset();
  resolveRunSpy.mockReset();
  findLastOutboundSpy.mockReset();
});

describe('forge_coolify_deploy → list', () => {
  it('maps active integrations including breakerOpen + resourceUuid', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([
      {
        id: STAGING_INT,
        environment: 'staging',
        config: { resourceUuid: 'res-staging' },
        lastHealthStatus: 'ok',
        breakerOpenedAt: null,
      },
      {
        id: PROD_INT,
        environment: 'prod',
        config: {},
        lastHealthStatus: null,
        breakerOpenedAt: new Date(),
      },
    ]);

    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      integrations: Array<{
        id: string;
        environment: string;
        resourceUuid: string | null;
        breakerOpen: boolean;
      }>;
    };

    expect(result.integrations).toHaveLength(2);
    expect(result.integrations[0]).toMatchObject({
      id: STAGING_INT,
      environment: 'staging',
      resourceUuid: 'res-staging',
      breakerOpen: false,
    });
    expect(result.integrations[1]).toMatchObject({
      environment: 'prod',
      resourceUuid: null,
      breakerOpen: true,
    });
  });

  it('returns an empty array when no Coolify is configured', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([]); // no integrations
    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      integrations: unknown[];
    };
    expect(result.integrations).toEqual([]);
  });

  it('rejects a non-member with FORBIDDEN', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    resultQueue.push([{ ownerId: 'someone-else' }]); // project owner mismatch
    resultQueue.push([]); // no projectMembers row
    await expect(tool.handler({ action: 'list', projectId: PROJECT_ID })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });
});

describe('forge_coolify_deploy → deploy', () => {
  it('requires issueId', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    await expect(tool.handler({ action: 'deploy', projectId: PROJECT_ID })).rejects.toThrow(
      /issueId is required/,
    );
    expect(tryDispatchSpy).not.toHaveBeenCalled();
  });

  it('delegates a staging deploy to tryDispatchCoolifyRelease and passes the outcome through', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
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
    });
    expect(result.dispatched).toBe(true);
    expect(result.integrationIds).toEqual([STAGING_INT]);
  });

  it('passes force:true through to tryDispatchCoolifyRelease for a re-deploy', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: true,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
    });

    await tool.handler({ action: 'deploy', projectId: PROJECT_ID, issueId: ISSUE_ID, force: true });

    expect(tryDispatchSpy).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      runId: 'run-1',
      force: true,
    });
  });

  it('surfaces reason:already-dispatched from a deduped (non-force) deploy', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
    tryDispatchSpy.mockResolvedValueOnce({
      dispatched: false,
      pendingHumanConfirm: false,
      integrationIds: [STAGING_INT],
      reason: 'already-dispatched',
    });

    const result = (await tool.handler({
      action: 'deploy',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { dispatched: boolean; reason: string };

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe('already-dispatched');
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
  });

  it('passes the prod human-confirm gate through (pendingHumanConfirm, no dispatch)', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resolveRunSpy.mockResolvedValueOnce('run-1');
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
});

describe('forge_coolify_deploy → status', () => {
  it('returns the latest outbound delivery per active integration', async () => {
    const tool = forgeCoolifyDeployTool(makeDeviceCtx());
    pushMemberOk();
    resultQueue.push([
      {
        id: STAGING_INT,
        environment: 'staging',
        config: { resourceUuid: 'res-staging' },
        lastHealthStatus: 'ok',
        breakerOpenedAt: null,
      },
    ]);
    findLastOutboundSpy.mockResolvedValueOnce({
      status: 'ok',
      response: { deployment_uuid: 'dep-123' },
      createdAt: new Date('2026-05-27T00:00:00Z'),
    });

    const result = (await tool.handler({ action: 'status', projectId: PROJECT_ID })) as {
      deliveries: Array<{ integrationId: string; deploymentUuid: string | null; status: string }>;
    };

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      integrationId: STAGING_INT,
      deploymentUuid: 'dep-123',
      status: 'ok',
      breakerOpen: false,
    });
  });
});
