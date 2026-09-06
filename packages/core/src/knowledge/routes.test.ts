import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  assertProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const runUnifiedSearchMock = vi.fn(async (_input: unknown) => ({
  knowledge: [{ slug: 'a-convention', score: 0.9, origin: 'knowledge' }],
  memory: [],
}));
vi.mock('./unified-search.js', () => ({
  runUnifiedSearch: (input: unknown) => runUnifiedSearchMock(input),
}));

const getKnowledgeEntryMock = vi.fn(async (..._args: unknown[]) => null);
vi.mock('./service.js', async () => ({
  deleteKnowledgeEntry: vi.fn(),
  getKnowledgeEntry: (...args: unknown[]) => getKnowledgeEntryMock(...args),
  listKnowledgeEntries: vi.fn(async () => []),
  upsertKnowledgeEntry: vi.fn(),
  upsertKnowledgeInputSchema: (await import('zod')).z.object({}).passthrough(),
}));

const { knowledgeRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { __resetRateLimitStore } = await import('../middleware/rate-limit.js');
const { EmbeddingUnavailableError } = await import('../embeddings/index.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SEARCH_PATH = `/api/projects/${PROJECT_ID}/knowledge/search`;

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', knowledgeRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  projectAccess.mockReset();
  __resetRateLimitStore();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function isMember() {
  projectAccess.mockResolvedValueOnce({ role: 'member' });
}

async function post(body: unknown, token?: string) {
  return buildApp().request(SEARCH_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/knowledge/search', () => {
  it('401 without a token', async () => {
    expect((await post({ query: 'retrieval' })).status).toBe(401);
  });

  it('403 for a caller with no membership', async () => {
    authVerified();
    projectAccess.mockRejectedValueOnce(
      new HTTPException(403, { message: 'not a project member' }),
    );
    const res = await post({ query: 'retrieval' }, await signUserToken(USER_ID));
    expect(res.status).toBe(403);
  });

  it('400 on a missing query rather than an unfiltered list', async () => {
    authVerified();
    isMember();
    expect((await post({ topK: 5 }, await signUserToken(USER_ID))).status).toBe(400);
  });

  it('400 on an empty query', async () => {
    authVerified();
    isMember();
    expect((await post({ query: '   ' }, await signUserToken(USER_ID))).status).toBe(400);
  });

  it('200 with the hits, and the MCP action defaults applied', async () => {
    authVerified();
    isMember();
    const res = await post({ query: 'retrieval' }, await signUserToken(USER_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ knowledge: [{ slug: 'a-convention' }] });
    expect(runUnifiedSearchMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      query: 'retrieval',
      scope: 'knowledge',
      topK: 10,
      strategy: 'semantic',
    });
  });

  it('passes scope, topK and strategy through', async () => {
    authVerified();
    isMember();
    const res = await post(
      { query: 'retrieval', scope: 'all', topK: 3, strategy: 'hybrid' },
      await signUserToken(USER_ID),
    );
    expect(res.status).toBe(200);
    expect(runUnifiedSearchMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      query: 'retrieval',
      scope: 'all',
      topK: 3,
      strategy: 'hybrid',
    });
  });

  it('400 on a topK above the bound the MCP action sets', async () => {
    authVerified();
    isMember();
    const res = await post({ query: 'retrieval', topK: 51 }, await signUserToken(USER_ID));
    expect(res.status).toBe(400);
  });

  it('503 EMBEDDING_UNAVAILABLE on an embeddings outage, not a 500', async () => {
    authVerified();
    isMember();
    runUnifiedSearchMock.mockRejectedValueOnce(new EmbeddingUnavailableError('provider down'));
    const res = await post({ query: 'retrieval' }, await signUserToken(USER_ID));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
  });

  it('leaves GET .../knowledge/:slug on the entry handler, unshadowed', async () => {
    authVerified();
    isMember();
    const res = await buildApp().request(SEARCH_PATH, {
      headers: { authorization: `Bearer ${await signUserToken(USER_ID)}` },
    });
    expect(res.status).toBe(404);
    expect(getKnowledgeEntryMock).toHaveBeenCalledWith(PROJECT_ID, 'search');
  });
});
