import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRequestClass } from '../mcp/request-class.js';

const scopes = vi.hoisted(() => ({ held: ['read'] as string[] }));

vi.mock('../credentials/pat.js', () => ({
  verifyPat: async () => ({
    row: { id: 'tok-1', userId: 'user-1', rateLimitMax: null },
    ownerKind: 'human',
  }),
  touchPatUsage: () => {},
}));
vi.mock('../credentials/pat-principal.js', () => ({
  patPrincipalOf: () => ({ kind: 'pat', tokenId: 'tok-1', userId: 'user-1', scopes: scopes.held }),
}));
vi.mock('../credentials/mcp-audit.js', () => ({ writeMcpAudit: () => {} }));
vi.mock('../credentials/ports.js', () => ({ tokenChanged: async () => {} }));
vi.mock('./rate-limit.js', () => ({
  consumeRateLimit: async () => ({
    allowed: true,
    max: 10,
    remaining: 9,
    resetMs: 1000,
    windowMs: 60000,
  }),
  getClientIp: () => null,
}));

const { requirePat } = await import('./require-pat.js');

function app() {
  const a = new Hono();
  a.onError((err, c) => {
    const status = 'status' in err ? (err.status as 403) : 500;
    return c.json({ message: err.message, cause: (err as { cause?: unknown }).cause }, status);
  });
  a.use('/mcp', mcpRequestClass(), requirePat());
  a.post('/mcp', (c) => c.json({ ok: true }));
  return a;
}

const call = (body: unknown) =>
  app().request('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer forge_pat_dev_abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const tool = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('a /mcp write from a token without the write scope', () => {
  beforeEach(() => {
    scopes.held = ['read'];
  });

  it('is refused by name, saying the scope and the tool', async () => {
    const res = await call(tool('forge_agent_report', { action: 'submit' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string; cause: { code: string } };
    expect(body.cause.code).toBe('INSUFFICIENT_SCOPE');
    expect(body.message).toContain("'write' scope");
    expect(body.message).toContain('forge_agent_report action=submit');
  });

  it("is refused for a write action that shares a name with another tool's read", async () => {
    // `release` is a channel write; no served tool reads under a name another one writes under.
    expect((await call(tool('forge_channel', { action: 'release' }))).status).toBe(403);
    expect((await call(tool('forge_ecosystem', { action: 'link_create' }))).status).toBe(403);
  });

  it('is refused for a tool this server does not serve, whatever its action', async () => {
    expect((await call(tool('forge_coolify_deploy', { action: 'status' }))).status).toBe(403);
  });

  it('is refused when a read hides in a batch with a write', async () => {
    const res = await call([
      tool('forge_agent_report', { action: 'list' }),
      tool('forge_agent_report', { action: 'submit' }),
    ]);
    expect(res.status).toBe(403);
  });

  it('is refused for a body that is not an envelope (fails closed)', async () => {
    expect((await call('nonsense')).status).toBe(403);
  });

  it('lets a read through', async () => {
    expect((await call(tool('forge_agent_report', { action: 'list' }))).status).toBe(200);
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  });

  it("lets every served tool's read through, the action-less upload fetch included", async () => {
    expect((await call(tool('forge_channel', { action: 'inbox' }))).status).toBe(200);
    expect((await call(tool('forge_ecosystem', { action: 'interface' }))).status).toBe(200);
    expect((await call(tool('forge_uploads', { data: {} }))).status).toBe(200);
    expect((await call(tool('forge_uploads', { action: 'fetch', data: {} }))).status).toBe(200);
  });

  it("lets the product tools' reads through and holds their writes", async () => {
    expect((await call(tool('forge_releases', { action: 'list' }))).status).toBe(200);
    expect((await call(tool('forge_design', { action: 'mockup_get' }))).status).toBe(200);
    expect((await call(tool('forge_questions', { action: 'get' }))).status).toBe(200);
    expect((await call(tool('forge_issues', { action: 'get' }))).status).toBe(200);
    expect((await call(tool('forge_releases', { action: 'decide' }))).status).toBe(403);
    expect((await call(tool('forge_design', { action: 'suggestion_accept' }))).status).toBe(403);
    expect((await call(tool('forge_questions', { action: 'ask' }))).status).toBe(403);
  });

  it('lets forge_issues create through to its refusal: it writes nothing', async () => {
    expect((await call(tool('forge_issues', { action: 'create' }))).status).toBe(200);
  });

  it('lets a token holding write do the same write', async () => {
    scopes.held = ['read', 'write'];
    expect((await call(tool('forge_agent_report', { action: 'submit' }))).status).toBe(200);
  });
});
