import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ read: vi.fn(), can: vi.fn() }));
vi.mock('./service.js', () => ({
  readKnowledgeEntry: store.read,
  deleteKnowledgeEntry: vi.fn(),
  listKnowledgeEntries: vi.fn(),
}));
vi.mock('./unified-search.js', () => ({ runUnifiedSearch: vi.fn() }));
vi.mock('./upsert.js', () => ({ upsertKnowledgeEntry: vi.fn() }));
vi.mock('../permissions/index.js', () => ({
  actorFor: (id: string) => ({ id }),
  projectResource: (id: string) => ({ id }),
  requireCan: store.can,
}));
vi.mock('../lib/tool.js', async (load) => ({
  ...(await load<typeof import('../lib/tool.js')>()),
  projectReaderOf: () => ({ userId: 'u-1', fence: null }),
}));

const { forgeKnowledgeTool } = await import('./tool.js');

const PROJECT = '0b6f1f5e-7a7e-4c43-9d56-0c5e9a3b2f11';
const tool = forgeKnowledgeTool({ principal: { userId: 'u-1' } } as never);

// ISS-867: the assistant reads an org's on-demand guide its prompt names through forge_knowledge get,
// the same read the project's REST door makes, never the project-only one
describe('forge_knowledge get', () => {
  beforeEach(() => {
    store.read.mockReset();
    store.can.mockReset().mockResolvedValue(undefined);
  });

  it("answers the org's entry where the project holds none, labelled as the org's", async () => {
    store.read.mockResolvedValue({ origin: 'org', slug: 'org-voice', body: 'Speak plainly.' });
    const got = await tool.handler({ action: 'get', projectId: PROJECT, slug: 'org-voice' });
    expect(store.read).toHaveBeenCalledWith(PROJECT, 'org-voice');
    expect(got).toMatchObject({ origin: 'org', body: 'Speak plainly.' });
  });

  it('refuses by name an entry neither holds, and reads nothing without project read', async () => {
    store.read.mockResolvedValue(null);
    await expect(
      tool.handler({ action: 'get', projectId: PROJECT, slug: 'no-such' }),
    ).rejects.toThrow(/NOT_FOUND/);
    store.can.mockRejectedValue(new Error('PERMISSION_FORBIDDEN'));
    await expect(
      tool.handler({ action: 'get', projectId: PROJECT, slug: 'org-voice' }),
    ).rejects.toThrow(/PERMISSION_FORBIDDEN/);
  });
});
