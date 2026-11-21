// @direct-test-of packages/core/src/middleware/pat-rest-surface.ts
// @direct-test-of packages/core/src/middleware/nearest-routes.ts
// @direct-test-of packages/core/src/lib/reads-sent-as-post.ts
// ISS-828: an agent's token refused on a route nothing serves is answered with the nearest served
// routes, the same as any other caller; the token surface answers that 404 before the app's own
// not-found handler runs, so it has to name them itself.
// ISS-1400: a search sent as a POST is a read at the token gate, for the grant and the scope alike.
import { type Context, Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error.js';
import type { RequestIdVars } from './request-id.js';

const held = vi.hoisted(() => ({
  scopes: ['read'] as string[],
  permissions: null as string[] | null,
  levels: [] as string[],
}));

vi.mock('./require-pat.js', () => ({
  authenticatePat: async (_c: unknown, _t: string, level: string) => {
    held.levels.push(level);
    return {
      kind: 'pat',
      tokenId: 't',
      userId: 'u',
      scopes: held.scopes,
      permissions: held.permissions,
      boundProjectId: null,
      projectIds: null,
    };
  },
}));

const { beginPatRequest, patLevelFor } = await import('./pat-rest-surface.js');
const { READS_SENT_AS_POST } = await import('../lib/reads-sent-as-post.js');

const app = new Hono<{ Variables: RequestIdVars }>();
app.use('/api/*', async (c, next) => {
  await beginPatRequest(c, 'forge_pat_test');
  await next();
});
app.post('/api/issues/:id/merge', (c: Context) => c.json({ ok: true }));
app.post('/api/memory/search', (c: Context) => c.json({ ok: true }));
app.post('/api/memory', (c: Context) => c.json({ ok: true }));
app.post('/api/projects/:id/knowledge/search', (c: Context) => c.json({ ok: true }));
app.post('/api/projects/:id/report-queries/:q/runs', (c: Context) => c.json({ ok: true }));
app.onError(errorHandler);

describe('a token on an unknown route under /api', () => {
  it('names the nearest served routes for the resource', async () => {
    const res = await app.request('/api/issues/abc/mrge');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      code: string;
      detail: string;
      details?: { nearest?: string[] };
    };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.detail).toContain('whatever the token holds');
    expect(body.detail).toContain('Nearest served: ');
    expect(body.detail).toContain('POST /api/issues/{id}/merge');
    expect(body.details?.nearest).toContain('POST /api/issues/{id}/merge');
  });

  it('names none where no served route shares the resource', async () => {
    const res = await app.request('/api/nowhere-at-all/x');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).not.toContain('Nearest');
  });
});

const PROJECT = '0b6c1d2e-3f40-4a5b-8c7d-9e0f1a2b3c4d';
const post = (path: string) => app.request(path, { method: 'POST' });
const refusal = async (res: Response) =>
  (await res.json()) as { code: string; details?: { wanted?: string } };

describe('a search sent as a POST, at the token gate (ISS-1400)', () => {
  const grant = (scopes: string[], permissions: string[]) => {
    held.scopes = scopes;
    held.permissions = permissions;
    held.levels = [];
  };

  it('answers a read-only token granted knowledge:read on memory search, spending the read budget', async () => {
    grant(['read'], ['knowledge:read']);
    expect((await post('/api/memory/search')).status).toBe(200);
    expect(held.levels).toEqual(['read']);
  });

  it("answers a read-only token on a project's knowledge search, on its mount's read grant", async () => {
    grant(['read'], ['knowledge:read', 'projects:read']);
    expect((await post(`/api/projects/${PROJECT}/knowledge/search`)).status).toBe(200);
  });

  it('refuses a token with no knowledge grant by name, wanting knowledge:read', async () => {
    grant(['read', 'write'], ['issues:read', 'issues:write', 'projects:write']);
    const res = await post('/api/memory/search');
    expect(res.status).toBe(403);
    const body = await refusal(res);
    expect(body.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(body.details?.wanted).toBe('knowledge:read');
  });

  it("refuses a project's knowledge search to a token without its read grant, wanting projects:read", async () => {
    grant(['read'], ['knowledge:read']);
    const body = await refusal(await post(`/api/projects/${PROJECT}/knowledge/search`));
    expect(body.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(body.details?.wanted).toBe('projects:read');
  });

  it('keeps the memory upsert a write: knowledge:read is refused wanting knowledge:write', async () => {
    grant(['read', 'write'], ['knowledge:read']);
    const body = await refusal(await post('/api/memory'));
    expect(body.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(body.details?.wanted).toBe('knowledge:write');
  });

  it("refuses the memory upsert to a read-only token for lacking the write scope", async () => {
    grant(['read'], ['knowledge:read', 'knowledge:write']);
    expect((await refusal(await post('/api/memory'))).code).toBe('INSUFFICIENT_SCOPE');
  });

  it('keeps a report run, a POST no read list names at the gate, a write', async () => {
    grant(['read', 'write'], ['projects:read']);
    const body = await refusal(await post(`/api/projects/${PROJECT}/report-queries/q/runs`));
    expect(body.details?.wanted).toBe('projects:write');
  });

  it('levels every route the reads list names a read, matching the whole route, never a prefix', () => {
    for (const call of READS_SENT_AS_POST) {
      const path = call.slice('POST '.length).replace(/:[a-z]+/g, PROJECT);
      expect(patLevelFor('POST', path)).toBe('read');
      expect(patLevelFor('POST', `${path}/extra`)).toBe('write');
      expect(patLevelFor('PUT', path)).toBe('write');
    }
    expect(patLevelFor('POST', '/api/memory')).toBe('write');
    expect(patLevelFor('POST', '/api/projects//knowledge/search')).toBe('write');
  });
});
