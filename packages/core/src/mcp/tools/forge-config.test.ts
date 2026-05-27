import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
  },
}));

const { forgeConfigTool } = await import('./forge-config.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateSet.mockClear();
  updateWhere.mockClear();
});

describe('forge_config tool (ISS-135 PR-A)', () => {
  it('omits branchConfig from the response when no issueId is supplied (backward-compat)', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    // assertDeviceOwnerIsMember: ownerId match short-circuits the membership query.
    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }]) // loadDeviceProjectRole project lookup
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          repoPath: '/repo',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: { categories: ['bug', 'feature'] },
        },
      ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      project: { id: string };
      config: Record<string, unknown>;
    };

    expect(result.project.id).toBe(PROJECT_ID);
    expect(result.config).not.toHaveProperty('branchConfig');
    expect(result.config.repoPath).toBe('/repo');
    expect(result.config.baseBranch).toBe('develop');
    expect(result.config.productionBranch).toBe('release');
    expect(result.config.categories).toEqual(['bug', 'feature']);
  });

  it('returns null branches (no fallback to main) when project columns are unset — surfaces misconfig instead of silently merging to main', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          repoPath: null,
          baseBranch: null,
          productionBranch: null,
          agentConfig: null,
        },
      ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      config: { baseBranch: string | null; productionBranch: string | null; repoPath: string | null };
    };

    expect(result.config.repoPath).toBeNull();
    expect(result.config.baseBranch).toBeNull();
    expect(result.config.productionBranch).toBeNull();
  });

  it('includes resolved branchConfig (project defaults) when issueId is supplied and the issue has no override', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }]) // membership project lookup
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: null,
        },
      ])
      .mockResolvedValueOnce([{ id: ISSUE_ID, sessionContext: null }]);

    const result = (await tool.handler({
      action: 'get',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { config: { branchConfig: { baseBranch: string; targetBranch: string; prodBranch: string } } };

    expect(result.config.branchConfig).toEqual({
      baseBranch: 'develop',
      targetBranch: 'develop',
      prodBranch: 'release',
    });
  });

  it('layers sessionContext.branchConfig override on top of project defaults', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: ISSUE_ID,
          sessionContext: { branchConfig: { baseBranch: 'feat/x' } },
        },
      ]);

    const result = (await tool.handler({
      action: 'get',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as { config: { branchConfig: { baseBranch: string; targetBranch: string; prodBranch: string } } };

    expect(result.config.branchConfig).toEqual({
      baseBranch: 'feat/x',
      targetBranch: 'feat/x',
      prodBranch: 'release',
    });
  });

  it('action=get exposes stateContext on the config response', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: {
            stateContext: {
              code: { budget: { perRunUsd: 2, perMonthUsd: 100, action: 'pause' } },
            },
          },
        },
      ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      config: { stateContext: Record<string, unknown> | null };
    };

    expect(result.config.stateContext).toEqual({
      code: { budget: { perRunUsd: 2, perMonthUsd: 100, action: 'pause' } },
    });
  });

  it('action=update merges a stateContext patch (preserves untouched states)', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }]) // assertPrincipalIsAdmin: project lookup
      .mockResolvedValueOnce([
        {
          agentConfig: {
            pipelineConfig: { enabled: true },
            stateContext: { plan: { blocks: { tip: 'keep' } } },
          },
        },
      ]) // read current agentConfig for merge
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: {
            pipelineConfig: { enabled: true },
            stateContext: {
              plan: { blocks: { tip: 'keep' } },
              code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
            },
          },
        },
      ]); // readProjectConfig for response

    const result = (await tool.handler({
      action: 'update',
      projectId: PROJECT_ID,
      stateContext: {
        code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
      },
    })) as { config: { stateContext: Record<string, unknown> } };

    expect(updateSet).toHaveBeenCalledWith({
      agentConfig: {
        pipelineConfig: { enabled: true },
        stateContext: {
          plan: { blocks: { tip: 'keep' } },
          code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
        },
      },
    });
    expect(result.config.stateContext).toEqual({
      plan: { blocks: { tip: 'keep' } },
      code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } },
    });
  });

  it('action=update rejects an invalid budget (negative perRunUsd)', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    await expect(
      tool.handler({
        action: 'update',
        projectId: PROJECT_ID,
        stateContext: {
          code: { budget: { perRunUsd: -1, perMonthUsd: 50, action: 'pause' } },
        },
      }),
    ).rejects.toThrow();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when issueId refers to an issue outside the project', async () => {
    const tool = forgeConfigTool({ principal: { kind: 'device', device: fakeDevice }, device: fakeDevice, projectSlug: null });

    selectLimit
      .mockResolvedValueOnce([{ ownerId: OWNER_ID }])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          productionBranch: 'release',
          agentConfig: null,
        },
      ])
      .mockResolvedValueOnce([]); // issue lookup returns empty

    await expect(
      tool.handler({
        action: 'get',
        projectId: OTHER_PROJECT_ID,
        issueId: ISSUE_ID,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});
