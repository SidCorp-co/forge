import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ read: vi.fn(), upsert: vi.fn() }));
vi.mock('./service.js', () => ({
  readKnowledgeEntry: store.read,
  deleteKnowledgeEntry: vi.fn(),
  listKnowledgeEntries: vi.fn(),
}));
vi.mock('./unified-search.js', () => ({ runUnifiedSearch: vi.fn() }));
vi.mock('./upsert.js', () => ({ upsertKnowledgeEntry: store.upsert }));
vi.mock('../lib/tool.js', async (load) => ({
  ...(await load<typeof import('../lib/tool.js')>()),
  projectReaderOf: () => ({ userId: 'u-1', fence: null }),
}));

const { forgeKnowledgeTool } = await import('./tool.js');
const { toolPermissionFor } = await import('../permissions/index.js');

const PROJECT = '0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11';
const tool = forgeKnowledgeTool({ principal: { userId: 'u-1' } } as never);

// ISS-867: the assistant reads an org's on-demand guide its prompt names through forge_knowledge get,
// the same read the project's REST door makes, never the project-only one
describe('forge_knowledge get', () => {
  beforeEach(() => {
    store.read.mockReset();
  });

  it("answers the org's entry where the project holds none, labelled as the org's", async () => {
    store.read.mockResolvedValue({ origin: 'org', slug: 'org-voice', body: 'Speak plainly.' });
    const got = await tool.handler({ action: 'get', projectId: PROJECT, slug: 'org-voice' });
    expect(store.read).toHaveBeenCalledWith(PROJECT, 'org-voice');
    expect(got).toMatchObject({ origin: 'org', body: 'Speak plainly.' });
  });

  it('refuses by name an entry neither holds', async () => {
    store.read.mockResolvedValue(null);
    await expect(
      tool.handler({ action: 'get', projectId: PROJECT, slug: 'no-such' }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  // ISS-947: project read is checked at the door (`runDeclaredTool`) on the project projectId names,
  // so the handler reads nothing a caller without it asked for
  it('declares project read on the project its projectId names, and project write for a write', () => {
    for (const action of ['list', 'get', 'search'])
      expect(toolPermissionFor(tool.permission, action)).toEqual({
        permission: 'project.read',
        on: { arg: 'projectId' },
      });
    for (const action of ['upsert', 'delete'])
      expect(toolPermissionFor(tool.permission, action)).toEqual({
        permission: 'project.write',
        on: { arg: 'projectId' },
      });
  });
});

// ISS-1064: the tool's upsert carries what an entry rests on, where it applies and when it needs
// re-checking to the one write path, which refuses a kind owing them that leaves one out
describe('forge_knowledge upsert', () => {
  it('passes source, entryScope as scope, and recheckWhen to the write', async () => {
    store.upsert.mockReset().mockResolvedValue({ id: 'k-1', slug: 'deploy-notes' });
    await tool.handler({
      action: 'upsert',
      projectId: PROJECT,
      slug: 'deploy-notes',
      title: 'Deploy',
      body: 'Deploy with the script.',
      kind: 'reference',
      source: 'scripts/deploy.sh:main',
      entryScope: 'every deploy of this project',
      recheckWhen: 'scripts/deploy.sh moves',
      scope: 'knowledge',
    });
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reference',
        source: 'scripts/deploy.sh:main',
        scope: 'every deploy of this project',
        recheckWhen: 'scripts/deploy.sh moves',
      }),
    );
  });
});
