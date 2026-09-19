import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const dbUpdate = vi.fn(() => ({ set: updateSet }));

const dbExecute = vi.fn(async (_statement: unknown): Promise<unknown[]> => []);

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: dbUpdate,
    execute: dbExecute,
  },
}));

const { forgeConfigTool } = await import('./forge-config.js');
const { getGuide } = await import('../../guides/registry.js');
const { FORGE_FACTS } = await import('../../prompt/facts/registry.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const ORG_ID = '88888888-8888-4888-8888-888888888888';

// effectiveProjectRole (lib/authz.ts) result rows — ONE org-aware select.
const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };
const adminAccessRow = { orgId: ORG_ID, memberRole: 'admin', orgRole: null };

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID, {
  scopes: ['read', 'write', 'admin'],
});

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateSet.mockClear();
  updateWhere.mockClear();
});

describe('forge_config tool (ISS-135 PR-A)', () => {
  it('omits branchConfig from the response when no issueId is supplied (backward-compat)', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit
      .mockResolvedValueOnce([memberAccessRow]) // assertPrincipalIsMember: effective-role lookup
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          repoPath: '/repo',
          baseBranch: 'develop',
          liveBranch: 'release',
          releaseModel: 'promote',
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
    expect(result.config.liveBranch).toBe('release');
    expect(result.config.categories).toEqual(['bug', 'feature']);
  });

  it('returns null branches (no fallback to main) when project columns are unset — surfaces misconfig instead of silently merging to main', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit.mockResolvedValueOnce([memberAccessRow]).mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'my-proj',
        name: 'My Project',
        repoPath: null,
        baseBranch: null,
        liveBranch: null,
        agentConfig: null,
      },
    ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      config: {
        baseBranch: string | null;
        liveBranch: string | null;
        repoPath: string | null;
      };
    };

    expect(result.config.repoPath).toBeNull();
    expect(result.config.baseBranch).toBeNull();
    expect(result.config.liveBranch).toBeNull();
  });

  it('includes resolved branchConfig (project defaults) when issueId is supplied and the issue has no override', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit
      .mockResolvedValueOnce([memberAccessRow])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          liveBranch: 'release',
          releaseModel: 'promote',
          agentConfig: null,
        },
      ])
      .mockResolvedValueOnce([{ id: ISSUE_ID, sessionContext: null }]);

    const result = (await tool.handler({
      action: 'get',
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    })) as {
      config: { branchConfig: { baseBranch: string; targetBranch: string; liveBranch: string } };
    };

    expect(result.config.branchConfig).toEqual({
      baseBranch: 'develop',
      targetBranch: 'develop',
      liveBranch: 'release',
    });
  });

  it('layers sessionContext.branchConfig override on top of project defaults', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit
      .mockResolvedValueOnce([memberAccessRow])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          liveBranch: 'release',
          releaseModel: 'promote',
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
    })) as {
      config: { branchConfig: { baseBranch: string; targetBranch: string; liveBranch: string } };
    };

    expect(result.config.branchConfig).toEqual({
      baseBranch: 'feat/x',
      targetBranch: 'feat/x',
      liveBranch: 'release',
    });
  });

  it('action=get no longer carries a stateContext key', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit.mockResolvedValueOnce([memberAccessRow]).mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'my-proj',
        name: 'My Project',
        baseBranch: 'develop',
        liveBranch: 'release',
        agentConfig: { stateContext: { code: { modelOverride: 'opus' } } },
      },
    ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      config: Record<string, unknown>;
    };

    expect(result.config).not.toHaveProperty('stateContext');
  });

  it('no agent-facing description of forge_config names stateContext', () => {
    const tool = forgeConfigTool({ principal: fakePrincipal, projectSlug: null });
    const factText = FORGE_FACTS.find((f) => f.id === 'mcp-tool-reference')?.render() ?? '';
    const guideText = getGuide('project-settings-and-test-credentials')?.body ?? '';

    expect(factText).toContain('forge_config');
    expect(guideText).toContain('forge_config');
    for (const text of [tool.description, factText, guideText]) {
      expect(text).not.toContain('stateContext');
    }
  });

  it('action=update writes a plugins patch for an admin principal', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit.mockResolvedValueOnce([adminAccessRow]).mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'my-proj',
        name: 'My Project',
        baseBranch: 'develop',
        liveBranch: 'release',
        releaseModel: 'promote',
        agentConfig: {},
      },
    ]);

    await tool.handler({
      action: 'update',
      projectId: PROJECT_ID,
      plugins: [{ marketplace: 'sidcorp-co/forge-plugin', name: 'forge' }],
    });

    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('action=update refuses a stateContext argument by name, and writes nothing', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    await expect(
      tool.handler({
        action: 'update',
        projectId: PROJECT_ID,
        stateContext: { code: { budget: { perRunUsd: 1, perMonthUsd: 50, action: 'pause' } } },
      }),
    ).rejects.toThrow(/pipelineConfig\.states\[\*\]\.model/);
    expect(updateSet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when issueId refers to an issue outside the project', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit
      .mockResolvedValueOnce([memberAccessRow])
      .mockResolvedValueOnce([
        {
          id: PROJECT_ID,
          slug: 'my-proj',
          name: 'My Project',
          baseBranch: 'develop',
          liveBranch: 'release',
          releaseModel: 'promote',
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

/**
 * ISS-1046 — the live branch is readable only under `promote`, and this tool's own description
 * promises exactly that. Its own describe because it is a different rule from the ISS-135 branch
 * layering above, and because the enclosing callback there is already at its frozen length.
 */
describe('forge_config tool — the retired agentConfig keys (ISS-1048)', () => {
  it.each([
    ['projectFacts', { 'done-means': 'new' }, /knowledge_entries/],
    ['projectFactsConfig', { 'done-means': { alwaysInject: true } }, /injection/],
  ])('action=update refuses %s by name, and writes nothing', async (key, value, expected) => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    await expect(
      tool.handler({ action: 'update', projectId: PROJECT_ID, [key]: value }),
    ).rejects.toThrow(expected);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('names forge_knowledge in both refusals, since that is where the caller must go', async () => {
    const tool = forgeConfigTool({ principal: fakePrincipal, projectSlug: null });
    for (const key of ['projectFacts', 'projectFactsConfig']) {
      await expect(
        tool.handler({ action: 'update', projectId: PROJECT_ID, [key]: {} }),
      ).rejects.toThrow(/forge_knowledge/);
    }
  });
});

describe('forge_config tool — the live branch under the release model', () => {
  it('returns no live branch for a `publish` project that still carries one', async () => {
    const tool = forgeConfigTool({
      principal: fakePrincipal,
      projectSlug: null,
    });

    selectLimit.mockResolvedValueOnce([memberAccessRow]).mockResolvedValueOnce([
      {
        id: PROJECT_ID,
        slug: 'my-proj',
        name: 'My Project',
        repoPath: '/repo',
        baseBranch: 'develop',
        liveBranch: 'legacy-production',
        releaseModel: 'publish',
        agentConfig: null,
      },
    ]);

    const result = (await tool.handler({ action: 'get', projectId: PROJECT_ID })) as {
      config: { liveBranch: string | null; releaseModel: string; baseBranch: string | null };
    };

    expect(result.config.liveBranch).toBeNull();
    // the model itself is still reported — a caller has to be able to tell `publish` from `none`
    expect(result.config.releaseModel).toBe('publish');
    expect(result.config.baseBranch).toBe('develop');
  });
});
