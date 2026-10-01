import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '11111111-1111-4111-8111-111111111111';

const createProject = vi.fn();
vi.mock('../../projects/service.js', () => ({
  createProject,
  ProjectSlugTakenError: class extends Error {},
  readProjectSummary: vi.fn(async () => ({ id: PROJECT, slug: 'my-proj', name: 'Renamed' })),
}));

const config = vi.hoisted(() => ({
  readProjectConfig: vi.fn(),
  writeProjectConfig: vi.fn(),
}));
vi.mock('../../project-config/service.js', () => config);

vi.mock('../../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  effectiveProjectRole: vi.fn(async () => ({ role: 'admin', orgRole: 'owner' })),
}));

const { forgeProjectsCreateTool, forgeProjectsUpdateTool } = await import('./forge-projects.js');


function update(patch: Record<string, unknown>) {
  const tool = forgeProjectsUpdateTool({ principal: { kind: 'user', userId: 'u-1' } } as never);
  return tool.handler({ projectId: PROJECT, patch } as never);
}

describe('forge_projects.update refuses the fields the project document replaced', () => {
  it.each([
    ['repoUrl', 'git@github.com:acme/app.git', '`source.git.repository`'],
    ['workspaceSetup', 'pnpm install', '`workspace.setup`'],
    ['workspaceSetup', null, '`workspace.setup`'],
    ['baseBranch', 'staging', '`source.git.defaultBranch`'],
    ['webhookSecret', 'secret-of-at-least-16-chars', 'no route reads a project webhook secret'],
    ['apiKey', 'fk_x', 'no route authenticated a project API key'],
  ])('names %s (%s) and where its value lives, and writes nothing', async (field, value, owner) => {
    await expect(update({ name: 'kept', [field]: value })).rejects.toThrow(
      new RegExp(`\`${field}\` is not a project field.*${owner.replaceAll('.', '\\.')}`),
    );
    expect(config.writeProjectConfig).not.toHaveBeenCalled();
  });
});

describe('forge_projects.create refuses the fields the project row no longer holds', () => {
  it.each([
    ['baseBranch', 'main', '`source.git.defaultBranch`'],
    ['webhookSecret', 'secret-of-at-least-16-chars', 'no route reads a project webhook secret'],
    ['apiKey', 'fk_x', 'no route authenticated a project API key'],
  ])('names %s and where its value lives, and creates nothing', async (field, value, owner) => {
    const tool = forgeProjectsCreateTool({ principal: { kind: 'user', userId: 'u-1' } } as never);
    await expect(
      tool.handler({ slug: 'my-proj', name: 'P', [field]: value } as never),
    ).rejects.toThrow(
      new RegExp(
        `\`${field}\` is not a project field.*${owner.replaceAll('.', '\\.').replaceAll('/', '\\/')}`,
      ),
    );
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('forge_projects.update renames through the project document', () => {
  const document = {
    version: 1,
    project: { id: PROJECT, slug: 'my-proj', name: 'Old' },
    source: { type: 'none' },
  };

  beforeEach(() => {
    config.readProjectConfig.mockReset();
    config.writeProjectConfig.mockReset();
  });

  it('writes project.name at the revision it read, and nothing else in the document', async () => {
    config.readProjectConfig.mockResolvedValue({ revision: 4, document });
    config.writeProjectConfig.mockResolvedValue({ ok: true, held: {}, created: false });

    await expect(update({ name: 'Renamed' })).resolves.toEqual({
      project: { id: PROJECT, slug: 'my-proj', name: 'Renamed' },
    });
    expect(config.writeProjectConfig).toHaveBeenCalledWith({
      projectId: PROJECT,
      userId: 'u-1',
      baseRevision: 4,
      raw: { ...document, project: { ...document.project, name: 'Renamed' } },
    });
  });

  it('refuses PROJECT_NOT_DECLARED for a project with no document, and writes nothing', async () => {
    config.readProjectConfig.mockResolvedValue(null);

    await expect(update({ name: 'Renamed' })).rejects.toThrow(
      /^BAD_REQUEST: PROJECT_NOT_DECLARED: .*PUT \/api\/projects\/:id\/config/,
    );
    expect(config.writeProjectConfig).not.toHaveBeenCalled();
  });

  it("names the document write's own refusal, STALE_BASE among them", async () => {
    config.readProjectConfig.mockResolvedValue({ revision: 4, document });
    config.writeProjectConfig.mockResolvedValue({
      ok: false,
      refusals: [{ code: 'STALE_BASE', path: '', detail: 'stored revision is 5' }],
    });

    await expect(update({ name: 'Renamed' })).rejects.toThrow(
      'BAD_REQUEST: STALE_BASE: STALE_BASE at /: stored revision is 5',
    );
  });
});
