import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const upsertKnowledgeEntryMock = vi.fn(async (..._args: unknown[]) => ({
  id: 'test-id',
  slug: 'test-slug',
  degraded: false,
  truncated: false,
}));
vi.mock('./service.js', () => ({
  upsertKnowledgeEntry: (input: unknown) => upsertKnowledgeEntryMock(input),
}));

const { knowledgeIngestRoutes, resetRateLimits } = await import('./ingest-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/knowledge', knowledgeIngestRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  projectAccess.mockReset();
  upsertKnowledgeEntryMock.mockClear();
  resetRateLimits();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/knowledge/ingest', () => {
  it('401 without token', async () => {
    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: PROJECT_ID, documents: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('400 empty documents', async () => {
    authVerified();
    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, documents: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('400 too many documents', async () => {
    authVerified();
    const docs = Array.from({ length: 21 }, (_, i) => ({
      id: `doc-${i}`,
      title: 't',
      content: 'c',
    }));
    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ projectId: PROJECT_ID, documents: docs }),
    });
    expect(res.status).toBe(400);
  });

  it('403 non-member', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        documents: [{ id: 'd', title: 't', content: 'c' }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it('200 ingests valid documents', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });

    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        documents: [
          { id: 'd1', title: 'T1', content: 'hello world' },
          { id: 'd2', title: 'T2', content: 'goodbye world' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; processed: number; skipped: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
    expect(upsertKnowledgeEntryMock).toHaveBeenCalledTimes(2);
    expect(upsertKnowledgeEntryMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      kind: 'reference',
      authoredBy: 'imported',
    });
  });

  it('skips oversized docs', async () => {
    authVerified();
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: 'member', orgRole: null });
    const oversized = 'x'.repeat(60 * 1024);

    const res = await buildApp().request('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        documents: [
          { id: 'd1', title: 'T1', content: oversized },
          { id: 'd2', title: 'T2', content: 'small' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      skipped: Array<{ id: string; reason: string }>;
    };
    expect(body.processed).toBe(1);
    expect(body.skipped[0]).toMatchObject({ id: 'd1', reason: 'content_exceeds_limit' });
  });
});
