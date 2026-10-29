// ISS-768: /mcp answers every protocol revision a client negotiates. A 2026-07-28 client (ChatGPT's
// connector) probes with `server/discover` under `MCP-Protocol-Version: 2026-07-28` and lists tools
// on the per-request envelope; a 2025-era client (Claude Code sends 2025-06-18) still opens with
// `initialize`. The endpoint is stateless, so GET and DELETE, the 2025 session operations, answer
// 405 naming POST instead of a stream that closes at once and is reopened every second.
//
// @direct-test-of packages/core/src/mcp/handler.ts

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { mcpMessageBody, mcpNoBody } from '../root-routes.js';
import { mcpHandler, mcpMethodNotAllowed } from './handler.js';
import { MCP_TOOLS } from './registry.js';
import { mcpRequestClass } from './request-class.js';
import { mcpTools, toolListing } from './server.js';

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const principal = {
  kind: 'pat',
  agency: 'agent',
  agentUserId: null,
  userId: '00000000-0000-4000-8000-000000000768',
  tokenId: 'tok-768',
  scopes: ['read', 'write'],
  projectIds: null,
  permissions: ['*'],
  grantEpoch: PAT_GRANT_EPOCH,
  boundProjectId: null,
  deviceId: null,
  onBehalfOf: null,
} as unknown as PrincipalVars['principal'];

/** /mcp as route-registry mounts it, with the principal `requirePat` would have admitted. */
function app() {
  const a = new Hono<{ Variables: PrincipalVars }>();
  a.use('/mcp', mcpRequestClass(), async (c, next) => {
    c.set('principal', principal);
    await next();
  });
  a.post('/mcp', mcpMessageBody, mcpHandler);
  a.on(['GET', 'DELETE'], '/mcp', mcpNoBody, mcpMethodNotAllowed);
  return a;
}

const listing = toolListing(mcpTools({ principal, projectSlug: null } as unknown as McpContext));
const clientInfo = { name: 'iss-768', version: '0.0.0' };

type RpcAnswer = {
  result?: Record<string, unknown> & {
    tools?: { name: string; inputSchema: unknown }[];
    supportedVersions?: string[];
  };
  error?: { code: number; message: string };
};

async function post(body: unknown, headers: Record<string, string>) {
  const res = await app().request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: RpcAnswer = {};
  try {
    json = JSON.parse(text) as RpcAnswer;
  } catch {}
  return { status: res.status, type: res.headers.get('content-type'), text, json };
}

/** A 2026-07-28 request: the per-request `_meta` envelope and the headers the revision requires. */
const modern = (id: number, method: string, params: Record<string, unknown> = {}) =>
  post(
    {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': clientInfo,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method },
  );

describe('/mcp at protocol 2026-07-28', () => {
  it('answers server/discover with the revisions it serves, 2026-07-28 among them', async () => {
    const res = await modern(1, 'server/discover');
    expect(res.status, res.text).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.result?.supportedVersions).toContain(MODERN);
    expect(res.json.result?.capabilities).toMatchObject({ tools: {}, prompts: {} });
    expect(res.json.result?.instructions).toMatch(/Forge-managed project/);
  });

  it('lists every registry tool under the 2026-07-28 header, with the inputs the contract publishes', async () => {
    const res = await modern(2, 'tools/list');
    expect(res.status, res.text).toBe(200);
    const tools = res.json.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
    for (const t of tools) {
      expect(t.inputSchema).toEqual(listing.find((l) => l.name === t.name)?.inputSchema);
    }
  });

  it('negotiates 2026-07-28 with the SDK client pinned to it, then lists tools', async () => {
    const a = app();
    const client = new Client(clientInfo, { versionNegotiation: { mode: { pin: MODERN } } });
    const transport = new StreamableHTTPClientTransport(new URL('http://core.test/mcp'), {
      fetch: async (url, init) => a.request(String(url), init),
    });
    await client.connect(transport);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
    } finally {
      await client.close();
    }
  });
});

describe('/mcp tools/call', () => {
  it('answers a 2026-07-28 call with the content a 2025-06-18 call gets', async () => {
    const name = 'forge_not_served';
    const now = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': clientInfo,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': name },
    );
    const then = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
      { 'mcp-protocol-version': '2025-06-18' },
    );
    expect(now.status, now.text).toBe(200);
    expect(then.status, then.text).toBe(200);
    expect(then.type).toMatch(/application\/json/);
    const expected = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    expect(now.json.result).toMatchObject(expected);
    expect(then.json.result).toEqual(expected);
  });
});

describe.each(LEGACY)('/mcp at protocol %s, stateless', (version) => {
  it('answers initialize at that revision, then tools/list with no session', async () => {
    const init = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo },
      },
      {},
    );
    expect(init.status, init.text).toBe(200);
    expect(init.type).toMatch(/application\/json/);
    expect(init.json.result).toMatchObject({
      protocolVersion: version,
      serverInfo: { name: '@forge/core' },
      capabilities: { tools: {}, prompts: {} },
    });
    expect(init.json.result?.instructions).toMatch(/Forge-managed project/);

    const list = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'mcp-protocol-version': version },
    );
    expect(list.status, list.text).toBe(200);
    expect((list.json.result?.tools ?? []).map((t) => t.name).sort()).toEqual(
      Object.keys(MCP_TOOLS).sort(),
    );
  });
});

describe('/mcp holds no session', () => {
  it.each(['GET', 'DELETE'])(
    'answers %s 405 naming POST, never an event stream',
    async (method) => {
      const res = await app().request('/mcp', {
        method,
        headers: { accept: 'text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/event-stream/);
    },
  );
});
