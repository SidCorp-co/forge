import { describe, expect, it, vi } from 'vitest';

const updateProject = vi.fn();
vi.mock('../../projects/service.js', () => ({
  createProject: vi.fn(),
  ProjectSlugTakenError: class extends Error {},
  readProjectSummary: vi.fn(),
  updateProject,
}));

const { forgeProjectsUpdateTool } = await import('./forge-projects.js');

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
  ])('names %s (%s) and where its value lives, and writes nothing', async (field, value, owner) => {
    await expect(update({ name: 'kept', [field]: value })).rejects.toThrow(
      new RegExp(`\`${field}\` is not a project field.*${owner.replaceAll('.', '\\.')}`),
    );
    expect(updateProject).not.toHaveBeenCalled();
  });
});
