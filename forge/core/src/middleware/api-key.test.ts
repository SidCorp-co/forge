import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const { requireProjectApiKey } = await import('./api-key.js');
const { errorHandler } = await import('./error.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function buildApp() {
  const app = new Hono<{ Variables: import('./api-key.js').ApiKeyVars }>();
  app.use('/secure/*', requireProjectApiKey());
  app.get('/secure/echo', (c) => c.json({ project: c.get('project') }));
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
});

describe('requireProjectApiKey', () => {
  it('401 API_KEY_REQUIRED when header missing', async () => {
    const res = await buildApp().request('/secure/echo');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('API_KEY_REQUIRED');
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('401 API_KEY_REQUIRED when key is too short', async () => {
    const res = await buildApp().request('/secure/echo', {
      headers: { 'X-Forge-API-Key': 'short' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('API_KEY_REQUIRED');
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('401 INVALID_API_KEY when key not found in DB', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/secure/echo', {
      headers: { 'X-Forge-API-Key': 'fk_not-a-real-key-but-long-enough' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_API_KEY');
  });

  it('case-insensitive header lookup (lowercase, mixed)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p', slug: 'p', name: 'P' }]);
    const res = await buildApp().request('/secure/echo', {
      headers: { 'x-forge-api-key': 'fk_valid-looking-key-from-test' },
    });
    expect(res.status).toBe(200);
  });

  it('200 + sets c.var.project when key matches', async () => {
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID, slug: 'forge-dev', name: 'Forge Dev' }]);
    const res = await buildApp().request('/secure/echo', {
      headers: { 'X-Forge-API-Key': 'fk_valid-looking-key-from-test' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: { id: string; slug: string; name: string } };
    expect(body.project.id).toBe(PROJECT_ID);
    expect(body.project.slug).toBe('forge-dev');
  });
});
