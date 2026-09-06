import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

vi.mock('../../db/client.js', () => ({ db: {} }));

const assertMember = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./lib.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib.js')>()),
  assertPrincipalIsMember: (...args: unknown[]) => assertMember(...args),
  assertPrincipalIsWriter: (...args: unknown[]) => assertMember(...args),
}));

const runUnifiedSearchMock = vi.fn(async (_input: unknown) => ({ knowledge: [], memory: [] }));
vi.mock('../../knowledge/unified-search.js', () => ({
  runUnifiedSearch: (input: unknown) => runUnifiedSearchMock(input),
}));

const upsertKnowledgeEntryMock = vi.fn(async (_input: unknown) => ({ id: 'k', slug: 's' }));
vi.mock('../../knowledge/service.js', async () => ({
  deleteKnowledgeEntry: vi.fn(),
  getKnowledgeEntry: vi.fn(),
  listKnowledgeEntries: vi.fn(),
  upsertKnowledgeEntry: (input: unknown) => upsertKnowledgeEntryMock(input),
  upsertKnowledgeInputSchema: (await import('zod')).z.object({}).passthrough(),
}));

const { forgeKnowledgeTool } = await import('./forge-knowledge.js');
const { EmbeddingUnavailableError } = await import('../../embeddings/index.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const tool = () =>
  forgeKnowledgeTool({
    principal: { kind: 'pat', userId: 'u', projectIds: [PROJECT_ID] },
  } as unknown as Parameters<typeof forgeKnowledgeTool>[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

// cm:why the outage below is not hypothetical: `runUnifiedSearch` degrades the knowledge arm to keyword, and it is the memory arm at `strategy: semantic` that rejects, because `memory/search-service.ts` degrades `hybrid` only.
describe('forge_knowledge maps an embeddings outage to UNAVAILABLE', () => {
  it('on search', async () => {
    runUnifiedSearchMock.mockRejectedValueOnce(new EmbeddingUnavailableError('provider down'));
    await expect(
      tool().handler({ action: 'search', projectId: PROJECT_ID, query: 'retrieval' }),
    ).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it('on upsert', async () => {
    upsertKnowledgeEntryMock.mockRejectedValueOnce(new EmbeddingUnavailableError('provider down'));
    await expect(
      tool().handler({ action: 'upsert', projectId: PROJECT_ID, slug: 's', title: 't', body: 'b' }),
    ).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it('search passes the four fields the REST twin takes, with the same defaults', async () => {
    await tool().handler({ action: 'search', projectId: PROJECT_ID, query: 'retrieval' });
    expect(runUnifiedSearchMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      query: 'retrieval',
      scope: 'knowledge',
      topK: 10,
      strategy: 'semantic',
    });
  });
});
