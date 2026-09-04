/**
 * ISS-894 — the generic fence in `createMcpServer` is what keeps a
 * project-scoped PAT inside its project across the WHOLE tool surface, and it
 * had no test: every existing MCP test builds `humanPat` with
 * `projectIds: null` / `boundProjectId: null`, so `allow !== null` is false and
 * the branch has never executed once.
 *
 * That matters most for the fourteen "device-scoped" tools. A PAT reaches them
 * — `ctx.device` is a synthesized stub carrying the PAT's user — and their
 * handlers call `assertDeviceOwnerIsMember`, which reads only `ownerId` and
 * knows nothing about the token's binding. This fence, and nothing in those
 * handlers, is what stops a token bound to one project reading another.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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

import type { Device } from '../auth/deviceToken.js';
import { createMcpServer } from './server.js';

const BOUND = '00000000-0000-4000-8000-00000000aaaa';
const FOREIGN = '00000000-0000-4000-8000-00000000bbbb';

const stubDevice: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  name: 'pat-stub',
  platform: 'linux',
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'stub0001',
  disabledAt: null,
  status: 'online',
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  machineId: null,
  gitCredentialRef: null,
  maxConcurrent: 1,
  createdAt: new Date(),
};

const boundPat = () =>
  ({
    kind: 'pat',
    agency: 'human',
    userId: stubDevice.ownerId,
    tokenId: '00000000-0000-4000-8000-0000000000cc',
    scopes: ['read', 'write'],
    projectIds: [BOUND],
    boundProjectId: null,
  }) as const;

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    principal: boundPat(),
    device: stubDevice,
    projectSlug: null,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

// cm:guard take the result as `unknown` — the SDK types `callTool` as a union whose other arm has no `content`, so a narrower parameter type does not compile and a cast at every call site is what the existing MCP tests do instead.
function textOf(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  return (content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? '';
}

/**
 * One per family. All four are device-scoped, so none of their handlers can
 * see the token's binding — if the fence stops firing, all four leak at once.
 */
const DEVICE_SCOPED = [
  'forge_memory.search',
  'forge_memory.write',
  'forge_step_handoff.get',
  'forge_skills.list',
] as const;

describe('a project-bound PAT cannot reach another project over MCP', () => {
  it.each(DEVICE_SCOPED)('%s refuses a foreign projectId', async (name) => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({ name, arguments: { projectId: FOREIGN } });
      expect(res.isError, name).toBe(true);
      // cm:guard the refusal must read NOT_FOUND, never FORBIDDEN — a 403 confirms the project exists and turns every one of these tools into an existence oracle for projects the caller cannot see. The wording is the assertion; softening it to a generic "is an error" check would pass while the oracle came back.
      expect(textOf(res), name).toContain('not found or not accessible');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lets the same token through on the project it is bound to', async () => {
    const { client, server } = await connect();
    try {
      const res = await client.callTool({
        name: 'forge_memory.search',
        arguments: { projectId: BOUND, query: 'x', topK: 1, strategy: 'keyword' },
      });
      // cm:guard assert what the refusal is NOT, never that the call succeeds — the db is stubbed here, so a bound-project call still fails, just further in. Strengthening this to expect success would make it fail for a reason that has nothing to do with the fence, and the point of the case is only to show the fence is scoped rather than refusing everything.
      expect(textOf(res)).not.toContain('not found or not accessible');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
