// REQ-73 BC-5 (ISS-602): every /mcp tool answers a wrong argument in Forge's named refusal form,
// { error: { code, message, refusals } } with the valid shape, never a validator dump, and never
// hands back a credential the call carried. Driven through the MCP server over the SDK's own
// transport, for every tool the registry serves, so a tool added later is covered here unasked.
//
// @direct-test-of packages/core/src/mcp/server.ts
// @direct-test-of packages/core/src/lib/tool.ts
// @direct-test-of packages/core/src/lib/tool-args.ts

import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import { RefusalError } from '../lib/refusal.js';
import { type McpContext, type McpTool, zodToMcpSchema } from '../lib/tool.js';
import { need } from '../lib/tool-args.js';
import { provideChatWriteHold } from '../middleware/chat-write-hold.js';
import { badRequest } from '../middleware/route-errors.js';
import { gatedTool, JUDGES_OWN_ARGUMENTS, shapeOf } from './input-gate.js';
import { MCP_TOOLS } from './registry.js';
import { createMcpServer, mcpTools } from './server.js';

const ctx = {
  principal: {
    kind: 'pat',
    agency: 'agent',
    agentUserId: null,
    userId: '00000000-0000-4000-8000-000000000001',
    tokenId: 'tok-602',
    scopes: ['read', 'write'],
    projectIds: null,
    permissions: ['*'],
    grantEpoch: PAT_GRANT_EPOCH,
    boundProjectId: null,
    deviceId: null,
    onBehalfOf: null,
  },
  projectSlug: null,
} as unknown as McpContext;

// fabricated for this test, never a real credential: it has the shape the scrubber reads as a token
const TOKEN = ['forge', 'pat', 'dev', randomBytes(24).toString('hex')].join('_');
const TOKEN_TAIL = TOKEN.slice(-24);

type Envelope = {
  code?: string;
  detail?: string;
  error?: {
    code?: string;
    message?: string;
    refusals?: { code: string; path: string; detail: string }[];
  };
};

async function call(name: string, args: Record<string, unknown>) {
  const server = createMcpServer(ctx);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'iss-602', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    let body: Envelope = {};
    try {
      body = JSON.parse(text) as Envelope;
    } catch {}
    return { isError: result.isError === true, text, body };
  } finally {
    await client.close();
    await server.close();
  }
}

const tools = mcpTools(ctx);
const names = Object.keys(MCP_TOOLS);

/** An action the tool takes that reads its arguments (forge_issues answers `create` before them). */
function anAction(tool: McpTool): string | undefined {
  const action = (
    tool.inputSchema.properties as Record<
      string,
      { enum?: string[]; const?: string; default?: string }
    >
  ).action;
  const values = action?.enum ?? (action?.const ? [action.const] : []);
  return values.find((a) => a !== 'create') ?? action?.default;
}

/** A field the tool takes beside `action` and `projectId`, sent as a value of the wrong type. */
function wrongTyped(tool: McpTool): Record<string, unknown> {
  const props = tool.inputSchema.properties as Record<string, { type?: unknown }>;
  const field = Object.keys(props).find((k) => k !== 'action' && k !== 'projectId');
  if (!field) return {};
  return { [field]: props[field]?.type === 'object' ? 'not an object' : { not: 'this type' } };
}

function expectNamedRefusal(tool: string, answer: Awaited<ReturnType<typeof call>>) {
  expect(answer.isError, `${tool}: ${answer.text}`).toBe(true);
  expect(answer.text, `${tool} answered a validator dump`).not.toMatch(/^Error: \[/);
  const error = answer.body.error;
  expect(error?.code, `${tool}: ${answer.text}`).toEqual(expect.any(String));
  expect(error?.message, `${tool}: ${answer.text}`).toEqual(expect.any(String));
  expect(error?.refusals?.length, `${tool}: ${answer.text}`).toBeGreaterThan(0);
  for (const r of error?.refusals ?? []) {
    expect(r, `${tool}: ${answer.text}`).toMatchObject({
      code: expect.any(String),
      path: expect.any(String),
      detail: expect.any(String),
    });
  }
}

beforeAll(() => {
  provideChatWriteHold({
    hold: async () => {},
    admit: async () => {},
    tool: async () => null,
  } as unknown as Parameters<typeof provideChatWriteHold>[0]);
});

describe('forge_uploads refuses a wrong argument by name with its valid shape (c1)', () => {
  const data = { target: 'issue', attachmentId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' };
  const cases: [string, Record<string, unknown>, string][] = [
    [
      'a projectId, which it takes none of (FB-175)',
      { data, projectId: data.attachmentId },
      '/projectId',
    ],
    ['an extra key', { action: 'fetch', data, note: 'x' }, '/note'],
    ['an extra key inside data', { data: { ...data, issue: 'ISS-1' } }, '/data/issue'],
    ['data left out', { action: 'fetch' }, '/data'],
    ['a nested wrong type', { data: { ...data, attachmentId: 42 } }, '/data/attachmentId'],
    ['a value outside the enum', { data: { ...data, target: 'release' } }, '/data/target'],
  ];
  for (const [what, args, path] of cases) {
    it(`answers ${what} at ${path}`, async () => {
      const answer = await call('forge_uploads', args);
      expectNamedRefusal('forge_uploads', answer);
      expect(answer.body.error?.code).toBe('BAD_REQUEST');
      expect(answer.body.error?.refusals?.map((r) => r.path)).toContain(path);
      expect(answer.body.detail).toBe(
        'forge_uploads takes { action: "fetch", data: { target: "issue" | "comment" | "session", attachmentId: uuid } }',
      );
      for (const r of answer.body.error?.refusals ?? [])
        expect(r.detail).toContain('attachmentId: uuid');
    });
  }
});

describe('every MCP tool answers a wrong argument in the named form (c2)', () => {
  it('serves every registry tool behind the gate', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...names].sort());
  });

  for (const name of names) {
    const tool = tools.find((t) => t.name === name) as McpTool;

    it(`${name}: an unknown key`, async () => {
      expectNamedRefusal(name, await call(name, { action: anAction(tool), notAnArgument: 1 }));
    });

    it(`${name}: an action it does not take, and one of the wrong type`, async () => {
      for (const action of ['no_such_action', 42]) {
        const answer = await call(name, { action });
        expectNamedRefusal(name, answer);
        expect(answer.body.error?.refusals?.[0]).toMatchObject({
          code: 'BAD_REQUEST',
          path: '/action',
        });
        expect(answer.body.detail).toMatch(new RegExp(`^${name} takes \\{ action`));
        expect(answer.text).not.toContain('no_such_action');
      }
    });

    it(`${name}: a field of the wrong type`, async () => {
      expectNamedRefusal(name, await call(name, { action: anAction(tool), ...wrongTyped(tool) }));
    });
  }

  // K74 on dev.307: these answered `Error: requirement is required for get: …`, no code, no shape
  const omissions: [string, string, string][] = [
    ['forge_requirements', 'get', 'requirement'],
    ['forge_requirements', 'progress', 'requirement'],
    ['forge_requirements', 'similar', 'text'],
    ['forge_requirements', 'propose', 'requirement'],
    ['project_feedback', 'get', 'feedback'],
    ['project_feedback', 'clarify', 'feedback'],
  ];
  for (const [name, action, field] of omissions) {
    it(`${name}: ${action} without ${field}, at /${field} with the shape`, async () => {
      const answer = await call(name, {
        action,
        projectId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      });
      expectNamedRefusal(name, answer);
      expect(answer.body.error?.code).toBe('BAD_REQUEST');
      expect(answer.body.error?.refusals?.[0]?.path).toBe(`/${field}`);
      expect(answer.body.error?.refusals?.[0]?.detail).toMatch(
        new RegExp(`^action ${action} needs ${field} \\(.+\\); ${name} takes \\{ action`),
      );
      expect(answer.body.detail).toMatch(new RegExp(`^${name} takes \\{ action`));
    });
  }
});

describe('a refused call hands back no credential it carried (c3)', () => {
  for (const name of names) {
    const tool = tools.find((t) => t.name === name) as McpTool;
    const planted: [string, Record<string, unknown>][] = [
      ['as an unknown key', { action: anAction(tool), [TOKEN]: TOKEN }],
      ['as a wrong-typed value', { action: anAction(tool), ...wrongTyped(tool), extra: TOKEN }],
      ['as the action', { action: TOKEN }],
    ];
    for (const [where, args] of planted) {
      it(`${name}: a token ${where}`, async () => {
        const answer = await call(name, args);
        expect(answer.isError, answer.text).toBe(true);
        expect(answer.text).not.toContain(TOKEN_TAIL);
      });
    }
  }
});

describe('the gate', () => {
  const input = z.strictObject({ id: z.uuid() });
  const tool = (handler: McpTool['handler'], inputSchema = zodToMcpSchema(input)): McpTool => ({
    name: 'probe_tool',
    description: '',
    inputSchema,
    grant: 'issues:read',
    reach: 'project',
    handler,
  });

  it('lets a valid call through untouched', async () => {
    const gated = gatedTool(tool(async (args) => ({ ok: input.parse(args).id })));
    const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    await expect(gated.handler({ id })).resolves.toEqual({ ok: id });
  });

  it('answers a validator error from Forge’s own data as Forge’s fault, not the caller’s, and dumps nothing', async () => {
    const gated = gatedTool(tool(async () => z.object({ row: z.string() }).parse({ row: 1 })));
    const err = (await gated
      .handler({ id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' })
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/probe_tool could not read its own data: a fault in Forge/);
    expect(String(err.message)).not.toContain('invalid_type');
  });

  it('completes an argument refusal the handler throws with what the field is and the shape', async () => {
    const described = z.strictObject({ id: z.uuid().optional().describe('the row to read') });
    const gated = gatedTool(
      tool(async (args) => need(args, 'get', 'id'), zodToMcpSchema(described)),
    );
    const err = (await gated.handler({}).catch((e: unknown) => e)) as RefusalError;
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.refusals).toEqual([
      {
        code: 'BAD_REQUEST',
        path: '/id',
        detail: 'action get needs id (the row to read); probe_tool takes { id?: uuid }',
      },
    ]);
    expect(err.detail).toBe('probe_tool takes { id?: uuid }');
  });

  it('names a route helper’s 400 by the reason its cause keeps, never as a bare "Invalid input"', async () => {
    const gated = gatedTool(
      tool(async () => {
        throw badRequest('`ISS602` is not an issue key: write it like `ISS-12`');
      }),
    );
    const err = (await gated
      .handler({ id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b' })
      .catch((e: unknown) => e)) as RefusalError;
    expect(err).toBeInstanceOf(RefusalError);
    expect(err.refusals[0]).toEqual({
      code: 'BAD_REQUEST',
      path: '',
      detail: '`ISS602` is not an issue key: write it like `ISS-12`; probe_tool takes { id: uuid }',
    });
  });

  it('reads a field left out as required, not as a type', async () => {
    const gated = gatedTool(tool(async (args) => input.parse(args)));
    const err = (await gated.handler({}).catch((e: unknown) => e)) as RefusalError;
    expect(err.refusals[0]?.detail).toBe('`id` is required; probe_tool takes { id: uuid }');
  });

  it('refuses at registration a tool whose input no validator stands behind', () => {
    expect(() => gatedTool(tool(async () => null, { type: 'object', properties: {} }))).toThrow(
      /probe_tool publishes an input no validator stands behind/,
    );
  });

  it('names only hand-written tools that judge their own arguments', () => {
    for (const name of Object.keys(JUDGES_OWN_ARGUMENTS)) expect(names).toContain(name);
  });

  it('renders a published input as one line', () => {
    expect(
      shapeOf({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['a', 'b'] },
          tags: { type: 'array', items: { type: 'string' } },
          at: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
        },
        required: ['kind'],
      }),
    ).toBe('{ kind: "a" | "b", tags?: string[], at?: date | null }');
  });
});
