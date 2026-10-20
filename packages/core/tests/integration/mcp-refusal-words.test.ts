/**
 * ISS-1421 r14 — every refusal an MCP tool answers reads as a sentence. Each tool the server lists
 * is called through the real server and a real Postgres with inputs it should refuse; every error
 * result's text must open on no lower-case letter past its codes, end with a full stop and never be
 * zod's "Invalid input". About a hundred hand-written refusals opened in lower case before.
 */

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ws/broadcast.js', () => ({
  broadcast: vi.fn(),
  broadcastToProject: vi.fn(),
}));

import { makeFakePrincipal } from '../../src/mcp/fake-principal.fixture.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

let harness: TestDatabase;
let client: Client;
let narrow: Client;
let isRefusalSentence: (text: string) => boolean;

async function connect(principal: ReturnType<typeof makeFakePrincipal>): Promise<Client> {
  const { createMcpServer } = await import('../../src/mcp/server.js');
  const server = createMcpServer({ principal, projectSlug: null, deprecations: new Set() });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'refusal-words', version: '0' });
  await c.connect(clientSide);
  return c;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'integration-test-pat-pepper-padded-to-32-chars-long';
  ({ isRefusalSentence } = await import('../../src/lib/refusal-sentence.js'));
  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, user.id);
  client = await connect(makeFakePrincipal(randomUUID(), user.id));
  narrow = await connect(makeFakePrincipal(randomUUID(), user.id, { projectIds: [project.id] }));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await narrow?.close();
  if (harness) await harness.cleanup();
});

type Listed = { name: string; inputSchema: { properties?: Record<string, unknown> } };

/** Inputs a tool should refuse: none at all, an action no tool has, every field of the wrong type. */
function probesOf(tool: Listed): Record<string, unknown>[] {
  const fields = Object.keys(tool.inputSchema.properties ?? {});
  return [
    {},
    { action: '__probe__' },
    Object.fromEntries(fields.map((f) => [f, { __probe__: true }])),
  ];
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const answered = c.callTool({ name, arguments: args });
  const late = new Promise<'late'>((r) => setTimeout(() => r('late'), 15_000));
  return Promise.race([answered, late]);
}

function judged(text: string): string | null {
  const said = text.replace(/^Error: /, '');
  if (/Invalid input/.test(said)) return 'carries "Invalid input"';
  return isRefusalSentence(said) ? null : 'is not a sentence';
}

describe('the refusals of every MCP tool', () => {
  it('read as sentences, whichever tool worded them', async () => {
    const { tools } = (await client.listTools()) as { tools: Listed[] };
    const wrong: string[] = [];
    let refused = 0;
    const unrefused: string[] = [];
    for (const tool of tools) {
      const before = refused;
      for (const args of probesOf(tool)) {
        const result = await call(client, tool.name, args);
        if (result === 'late') {
          wrong.push(`${tool.name} ${JSON.stringify(args)} did not answer in 15s`);
          continue;
        }
        if (!result.isError) continue;
        refused++;
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
        const why = judged(text);
        if (why) wrong.push(`${tool.name} ${JSON.stringify(args)} ${why}: ${text.slice(0, 2000)}`);
      }
      if (refused === before) unrefused.push(tool.name);
    }
    // Each tool is held to a refusal it gave, so a tool taking every probe cannot pass unread.
    expect(unrefused, 'each line is a tool that refused none of the probes').toEqual([]);
    // Not vacuous: most tools refuse at least one of the three probes.
    expect(tools.length).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(100);
    expect(wrong, 'each line is a tool refusal that is not a sentence').toEqual([]);
  }, 600_000);

  it("words the server's own refusals: a tool it does not serve, a project the token does not reach", async () => {
    const unknown = await client.callTool({ name: 'forge_nothing', arguments: {} });
    const other = await narrow.callTool({
      name: 'forge_issues',
      arguments: { action: 'list', projectId: randomUUID() },
    });
    for (const result of [unknown, other]) {
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(judged(text), text).toBeNull();
    }
  }, 60_000);
});
