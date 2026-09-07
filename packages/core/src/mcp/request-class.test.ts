/**
 * ISS-961 — which of the two per-token budgets an MCP request spends.
 *
 * The falsifying half is `defaults to write`: every other case here passes
 * for an implementation that returns `'read'` unconditionally, and such an
 * implementation would hand every write on `/mcp` the read budget. The
 * coverage test is the other half — a read-only tool renamed out from under
 * `READ_ONLY_TOOLS` leaves a dead entry that silently stops widening the
 * budget it was added for, and nothing else would say so.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    EMBEDDINGS_MODEL: 'test-model',
    EMBEDDINGS_DIM: 4,
    EMBEDDINGS_TIMEOUT_MS: 1000,
  },
}));

vi.mock('../db/client.js', () => ({ db: {} as unknown }));

import { makeFakePrincipal } from './fake-principal.fixture.js';
import {
  classifyMcpEnvelope,
  MCP_READ_ACTIONS,
  MCP_READ_ONLY_TOOLS,
  mcpRequestClass,
} from './request-class.js';
import { createMcpServer } from './server.js';

const call = (name: string, args?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, ...(args ? { arguments: args } : {}) },
});

describe('classifyMcpEnvelope', () => {
  it('reads a JSON-RPC method that only reads', () => {
    for (const method of ['initialize', 'tools/list', 'prompts/list', 'ping']) {
      expect(classifyMcpEnvelope({ jsonrpc: '2.0', id: 1, method })).toBe('read');
    }
  });

  it('reads a tools/call whose action is a read action', () => {
    expect(classifyMcpEnvelope(call('forge_issues', { action: 'list' }))).toBe('read');
    expect(classifyMcpEnvelope(call('forge_comments', { action: 'get', id: 'x' }))).toBe('read');
    expect(classifyMcpEnvelope(call('forge_knowledge', { action: 'search', q: 'x' }))).toBe('read');
  });

  it('writes a tools/call whose action mutates', () => {
    expect(classifyMcpEnvelope(call('forge_issues', { action: 'update' }))).toBe('write');
    expect(classifyMcpEnvelope(call('forge_comments', { action: 'create' }))).toBe('write');
    expect(classifyMcpEnvelope(call('forge_phase', { action: 'start' }))).toBe('write');
  });

  /**
   * The case review caught and no test here would have.
   *
   * `fetch` sat in `READ_ACTIONS` because it reads like a read. Its only
   * consumer, `forge_uploads action=fetch`, calls `assertPrincipalIsWriter`
   * and inserts a `download_tickets` row on every call — a writer-gated
   * mutation charged the 2400/min read budget instead of the 600/min write
   * one, and in direct contradiction of the guard on `READ_ACTIONS` itself.
   */
  // cm:guard this asserts the CONSUMER's authz, not the verb's spelling, and that is the whole lesson: a member of `READ_ACTIONS` is judged by what its handler does. Add a case here for any verb added there whose tool calls `assertPrincipalIsWriter` or writes a row.
  it('writes an action whose handler is writer-gated, however much its name reads like a read', () => {
    expect(
      classifyMcpEnvelope(
        call('forge_uploads', { action: 'fetch', data: { attachmentId: 'x', target: 'issue' } }),
      ),
    ).toBe('write');
    expect(classifyMcpEnvelope(call('forge_uploads', { action: 'request' }))).toBe('write');
  });

  it('reads the member-gated read actions the poll-heavy tools use', () => {
    expect(classifyMcpEnvelope(call('forge_issues', { action: 'listTasks' }))).toBe('read');
    for (const action of ['status', 'logs', 'runtime-logs', 'applications', 'targets']) {
      expect(classifyMcpEnvelope(call('forge_coolify_deploy', { action }))).toBe('read');
    }
    for (const action of ['deploy', 'cancel', 'rollback']) {
      expect(classifyMcpEnvelope(call('forge_coolify_deploy', { action }))).toBe('write');
    }
  });

  it('reads a read-only tool that takes no action argument', () => {
    expect(classifyMcpEnvelope(call('forge_memory.search', { query: 'x' }))).toBe('read');
    expect(classifyMcpEnvelope(call('forge_projects.list'))).toBe('read');
  });

  // cm:guard the falsifying case — remove the `'write'` default in `request-class.ts` and this is the only assertion in the file that goes red. Everything above it passes for an implementation that never returns `'write'` at all.
  it('defaults to write for an unrecognised tool, an unrecognised method and a broken envelope', () => {
    expect(classifyMcpEnvelope(call('forge_memory.write', { textContent: 'x' }))).toBe('write');
    expect(classifyMcpEnvelope(call('forge_tool_invented_next_release'))).toBe('write');
    expect(classifyMcpEnvelope({ jsonrpc: '2.0', id: 1, method: 'admin/doSomething' })).toBe(
      'write',
    );
    expect(classifyMcpEnvelope({ jsonrpc: '2.0', id: 1 })).toBe('write');
    expect(classifyMcpEnvelope(null)).toBe('write');
    expect(classifyMcpEnvelope('not an object')).toBe('write');
  });

  it('reads a batch only when every member reads', () => {
    const read = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(classifyMcpEnvelope([read, call('forge_issues', { action: 'get' })])).toBe('read');
    expect(classifyMcpEnvelope([read, call('forge_issues', { action: 'update' })])).toBe('write');
    expect(classifyMcpEnvelope([])).toBe('write');
  });
});

describe('mcpRequestClass', () => {
  const app = () => {
    const a = new Hono<{ Variables: { patRequestClass?: string } }>();
    a.use('/mcp', mcpRequestClass());
    a.all('/mcp', async (c) => {
      const body = c.req.method === 'POST' ? await c.req.raw.text() : '';
      return c.json({ charged: c.get('patRequestClass'), bodyStillReadable: body });
    });
    return a;
  };

  type Charged = { charged?: string; bodyStillReadable: string };
  const charged = (res: Response) => res.json() as Promise<Charged>;

  const post = (body: unknown) =>
    app().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sets the class on the context', async () => {
    const res = await post(call('forge_issues', { action: 'list' }));
    expect((await charged(res)).charged).toBe('read');
  });

  // cm:guard the whole reason this middleware clones rather than calling `c.req.json()`: the MCP transport is handed `c.req.raw` and reads the stream itself, so a middleware that consumes the original breaks every tool call with nothing naming this file.
  it('leaves the body readable for the handler behind it', async () => {
    const envelope = call('forge_issues', { action: 'list' });
    const res = await post(envelope);
    expect(JSON.parse((await charged(res)).bodyStillReadable)).toEqual(envelope);
  });

  it('charges the stricter budget when the body is not JSON', async () => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect((await charged(res)).charged).toBe('write');
  });

  it('reads a GET or DELETE, which carry no envelope', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app().request('/mcp', { method });
      expect((await charged(res)).charged).toBe('read');
    }
  });
});

describe('the read-only tool set against the live registry', () => {
  async function registeredToolNames(): Promise<string[]> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: makeFakePrincipal(
        '00000000-0000-4000-8000-0000000000b1',
        '00000000-0000-4000-8000-0000000000b2',
      ),
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((t) => t.name);
  }

  it('names only tools this core registers', async () => {
    const registered = new Set(await registeredToolNames());
    const dead = [...MCP_READ_ONLY_TOOLS].filter((name) => !registered.has(name));
    expect(dead).toEqual([]);
  });

  // cm:guard a tool whose schema REQUIRES an `action` can never reach the name set — `classifyMcpEnvelope` consults `action` first — so listing it there reads as load-bearing while doing nothing. `forge_collaborators` was listed until this assertion, and its schema takes `action: z.enum(['list'])` with no way to omit it.
  it('does not list a tool by name whose only classifier is its action', async () => {
    const registered = await registeredToolNames();
    expect(registered).toContain('forge_collaborators');
    expect(MCP_READ_ONLY_TOOLS.has('forge_collaborators')).toBe(false);
    expect(classifyMcpEnvelope(call('forge_collaborators', { action: 'list' }))).toBe('read');
    expect(MCP_READ_ACTIONS.has('list')).toBe(true);
    expect(MCP_READ_ACTIONS.has('update')).toBe(false);
    expect(MCP_READ_ACTIONS.has('fetch')).toBe(false);
  });
});
