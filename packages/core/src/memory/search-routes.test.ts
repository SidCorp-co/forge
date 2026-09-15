/** ISS-1041 criterion 10 — the route hands `embedMs` through beside `took_ms`. */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { EMBEDDINGS_MODEL: 'm' } }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'user-1');
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/rate-limit.js', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../config/rate-limits.js', () => ({ RULES: { memorySearch: {} } }));
vi.mock('../lib/authz.js', () => ({ assertProjectAccess: async () => ({ role: 'member' }) }));
vi.mock('../db/schema.js', () => ({ memorySources: ['issue', 'note'] }));
vi.mock('./search-service.js', () => ({
  memorySearchStrategies: ['semantic', 'keyword', 'hybrid'],
  runMemorySearch: async () => ({
    hits: [],
    model: 'm',
    took_ms: 12,
    embedMs: 7,
    strategy: 'semantic',
    reranked: false,
    expanded: false,
  }),
}));

const { memorySearchRoutes } = await import('./search-routes.js');

describe('POST /api/memory/search', () => {
  it('answers embedMs beside took_ms on a semantic search (criterion 10)', async () => {
    const app = new Hono();
    app.route('/api/memory', memorySearchRoutes);
    const res = await app.request('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: '87153ba0-1d92-427d-bc28-f508a163f6a4',
        query: 'what broke',
        strategy: 'semantic',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ took_ms: 12, embedMs: 7, strategy: 'semantic' });
  });
});
