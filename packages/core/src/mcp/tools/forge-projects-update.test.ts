import { describe, expect, it, vi } from 'vitest';

const updateProject = vi.fn();
const createProject = vi.fn();
vi.mock('../../projects/service.js', () => ({
  createProject,
  ProjectSlugTakenError: class extends Error {},
  readProjectSummary: vi.fn(),
  updateProject,
}));

const { forgeProjectsCreateTool, forgeProjectsUpdateTool } = await import('./forge-projects.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';

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
    expect(updateProject).not.toHaveBeenCalled();
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
