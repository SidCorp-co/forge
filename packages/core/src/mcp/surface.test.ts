// ISS-773: tools/list hands every client five small tools instead of every door with its whole
// guide (11 tools, 56 KB): forge_find, forge_describe and forge_call reach every action, and search
// and fetch are the names ChatGPT looks for. forge_call judges a call by its door's full input and
// refuses a wrong one by name, pointing at forge_describe.
//
// @direct-test-of packages/core/src/mcp/surface.ts

import { MCP_LISTED_TOOLS } from '@forge/contracts/mcp-tools';
import Ajv2020 from 'ajv/dist/2020.js';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import { provideChatWriteHold } from '../middleware/chat-write-hold.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { mcpMessageBody } from '../root-routes.js';
import { mcpHandler } from './handler.js';
import { mcpRequestClass } from './request-class.js';

const principal = {
  kind: 'pat',
  agency: 'agent',
  agentUserId: null,
  userId: '00000000-0000-4000-8000-000000000773',
  tokenId: 'tok-773',
  scopes: ['read', 'write'],
  projectIds: null,
  permissions: ['*'],
  grantEpoch: PAT_GRANT_EPOCH,
  boundProjectId: null,
  deviceId: null,
  onBehalfOf: null,
} as unknown as PrincipalVars['principal'];

// a pat credential is no chat credential; the hold the process entry provides is never reached
beforeAll(() => {
  provideChatWriteHold({
    hold: async () => {},
    admit: async () => {},
    tool: async () => null,
  } as unknown as Parameters<typeof provideChatWriteHold>[0]);
});

/** /mcp as route-registry mounts it, recording the class `mcpRequestClass` gave each request. */
function app(classes: string[] = []) {
  const a = new Hono<{ Variables: PrincipalVars }>();
  a.use('/mcp', mcpRequestClass(), async (c, next) => {
    classes.push(c.get('patRequestClass') ?? 'unclassed');
    c.set('principal', principal);
    await next();
  });
  a.post('/mcp', mcpMessageBody, mcpHandler);
  return a;
}

type Answer = {
  result?: {
    tools?: { name: string; inputSchema: Record<string, unknown> }[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

async function rpc(method: string, params: Record<string, unknown>, classes?: string[]) {
  const res = await app(classes).request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Answer };
}

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.json.result ?? {};
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map((c) => c.text).join('\n'),
    data: result.structuredContent ?? {},
  };
};

describe('tools/list', () => {
  it('lists the five tools alone, in at most 3 KB', async () => {
    const res = await rpc('tools/list', {});
    const tools = res.json.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([...MCP_LISTED_TOOLS]);
    const bytes = Buffer.byteLength(JSON.stringify({ tools }));
    expect(bytes).toBeLessThanOrEqual(3 * 1024);
  });

  it('lists each in strict JSON Schema', async () => {
    const strict = new Ajv2020({ strict: true, strictRequired: true });
    for (const t of (await rpc('tools/list', {})).json.result?.tools ?? []) {
      expect(strict.validateSchema(t.inputSchema), t.name).toBe(true);
      expect(() => strict.compile(t.inputSchema), t.name).not.toThrow();
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/"\$schema"/);
    }
  });
});

describe('forge_find and forge_describe', () => {
  it('finds requirements.create by what it does', async () => {
    const found = await call('forge_find', { query: 'draft a new requirement' });
    expect(found.isError).toBe(false);
    expect(
      (found.data.actions as string[]).some((a) => a.startsWith('requirements.create — ')),
    ).toBe(true);
  });

  it("answers one action's input and its own guide, and nothing of another action", async () => {
    const d = await call('forge_describe', { action: 'requirements.create' });
    expect(d.isError).toBe(false);
    expect(d.data).toMatchObject({
      action: 'requirements.create',
      input: { type: 'object', required: ['title'] },
      call: 'forge_call { action: "requirements.create", args }',
    });
    expect(d.data.guide).toMatch(/^create \{/);
    expect(d.data.guide).not.toMatch(/revise \{/);
    expect(Buffer.byteLength(d.text)).toBeLessThan(8 * 1024);
  });

  it('refuses an action that is not one by name, with the nearest', async () => {
    const d = await call('forge_describe', { action: 'requirements.creat' });
    expect(d.isError).toBe(true);
    expect(d.text).toMatch(/MCP_ACTION_UNKNOWN/);
    expect(d.text).toMatch(/requirements\.creat is no action; nearest: .*requirements\./);
  });
});

describe('forge_call', () => {
  const project = '00000000-0000-4000-8000-0000000007a3';

  it('judges args by the door input, refusing a key it does not take with the describe hint', async () => {
    const r = await call('forge_call', {
      action: 'issues.list',
      args: { projectId: project, nope: 1 },
    });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/BAD_REQUEST/);
    expect(r.text).toMatch(/Unrecognized key: \\"nope\\"/);
    expect(r.text).toContain(
      'forge_describe { action: "issues.list" } answers its input and guide.',
    );
  });

  it('refuses an action in args, an unknown action and a call without one, each by name', async () => {
    const inArgs = await call('forge_call', { action: 'issues.list', args: { action: 'get' } });
    expect(inArgs.text).toMatch(/MCP_CALL_ACTION_IN_ARGS/);
    const unknown = await call('forge_call', { action: 'issues.burn', args: {} });
    expect(unknown.text).toMatch(/MCP_ACTION_UNKNOWN/);
    const none = await call('forge_call', { args: {} });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/`action` is required/);
  });

  it('refuses a call to fetch with an id search never returns, by name', async () => {
    const r = await call('fetch', { id: 'project:abc' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/MCP_FETCH_ID_INVALID/);
  });
});

describe('the class of a forge_call is the class of the action it runs', () => {
  it.each([
    ['forge_call', { action: 'issues.list', args: {} }, 'read'],
    ['forge_call', { action: 'requirements.create', args: { title: 'x' } }, 'write'],
    ['forge_call', { action: 'requirements.get', args: {} }, 'read'],
    ['forge_call', { action: 'nodot', args: {} }, 'write'],
    ['forge_find', { query: 'x' }, 'read'],
    ['forge_describe', { action: 'requirements.create' }, 'read'],
    ['search', { query: 'x' }, 'read'],
    ['fetch', { id: 'issue:x' }, 'read'],
  ])('%s %j is %s', async (name, args, expected) => {
    const classes: string[] = [];
    await rpc('tools/call', { name, arguments: args }, classes);
    expect(classes).toEqual([expected]);
  });
});
