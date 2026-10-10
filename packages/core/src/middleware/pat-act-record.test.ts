import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];
vi.mock('../credentials/mcp-audit.js', () => ({
  writeMcpAudit: (row: Record<string, unknown>) => written.push(row),
}));

const { actResultOf, projectOfPath, recordingPatAct } = await import('./pat-act-record.js');

const P = '22222222-2222-4222-8222-222222222222';
const principal = { userId: 'u1', tokenId: 't1', deviceId: null } as never;

function app() {
  const a = new Hono();
  // two gates on one request, as two routers' requireAuth() are: the act is recorded once
  a.use('*', (c, next) => recordingPatAct(c, principal, next));
  a.use('*', (c, next) => recordingPatAct(c, principal, next));
  a.post(`/api/projects/:id/issues`, (c) => c.json({ ok: true }, 201));
  a.get(`/api/projects/:id/issues`, (c) => c.json([]));
  a.patch('/api/issues/:id', () => {
    throw new HTTPException(403, { message: 'no' });
  });
  return a;
}

describe('every act a token makes over REST is recorded against it (REQ-27 BC-2)', () => {
  beforeEach(() => {
    written.length = 0;
  });

  it('records a write once, naming the token, the route, the project and its result', async () => {
    const res = await app().request(`/api/projects/${P}/issues`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(written).toEqual([
      expect.objectContaining({
        tokenId: 't1',
        tool: 'rest',
        action: `POST /api/projects/${P}/issues`,
        projectId: P,
        resultCode: 'ok',
      }),
    ]);
  });

  it('records a refused write as forbidden', async () => {
    await app().request('/api/issues/x', { method: 'PATCH' });
    expect(written.map((w) => w.resultCode)).toEqual(['forbidden']);
  });

  it('records no row for a read', async () => {
    await app().request(`/api/projects/${P}/issues`);
    expect(written).toEqual([]);
  });

  it('reads the result and the project off the answer and the path', () => {
    expect([200, 404, 429, 500, 401].map(actResultOf)).toEqual([
      'ok',
      'not_found',
      'rate_limited',
      'error',
      'forbidden',
    ]);
    expect(projectOfPath('/api/issues/abc')).toBeNull();
  });
});
