/**
 * ISS-931 rule 2 — the four tools the pipeline cannot run without must work
 * under the credential a job or session actually holds, or the change does not
 * ship: `forge_step_start`, `forge_phase`, `forge_step_handoff.*` and
 * `forge_uploads`.
 *
 * Three of the four already asked `assertPrincipalIsWriter` before this issue.
 * What made them look device-scoped was `McpContext.device`, a row
 * `mcp/handler.ts` fabricated for every PAT — so the risk this file covers is
 * not that they reject a machine token today, it is that a later change
 * reintroduces a device requirement in front of one of them and nothing says
 * so until a pipeline stalls mid-run.
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

import { makeFakePrincipal } from './fake-principal.fixture.js';
import { createMcpServer } from './server.js';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const SESSION_ID = '00000000-0000-4000-8000-0000000000a2';
const JOB_ID = '00000000-0000-4000-8000-0000000000a3';
const ISSUE_ID = '00000000-0000-4000-8000-0000000000a4';

const KEEP_FOREVER = [
  { name: 'forge_step_start', args: { issueId: ISSUE_ID, stage: 'code' } },
  { name: 'forge_phase', args: { action: 'start', runId: JOB_ID, phase: 'code' } },
  { name: 'forge_step_handoff.write', args: { issueId: ISSUE_ID, step: 'code', summary: 's' } },
  { name: 'forge_step_handoff.get', args: { issueId: ISSUE_ID, step: 'code' } },
  { name: 'forge_uploads', args: { action: 'fetch', data: { attachmentId: ISSUE_ID } } },
] as const;

function sessionPrincipal(tokenId: string) {
  return makeFakePrincipal(tokenId, USER_ID, {
    agency: 'agent',
    machine: { kind: 'session', id: SESSION_ID },
  });
}

async function connect(tokenId: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ principal: sessionPrincipal(tokenId), projectSlug: null });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('the keep-forever tools under a `session:` token', () => {
  it('are all on the tool list a machine-minted token sees', async () => {
    const { client, server } = await connect('00000000-0000-4000-8000-0000000000b1');
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const { name } of KEEP_FOREVER) expect(names, name).toContain(name);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // cm:guard assert on the ABSENCE of a credential refusal, never on success — `db` is `{}` here, so every one of these calls fails further in, and a test written to expect success would be asserting the stub rather than the gate. A device requirement reintroduced in front of any of these four is what this case exists to catch, and it would arrive as exactly this text: the refusals in `project-authz.ts` and `require-pat.ts` are the only messages on this transport that name a device.
  it.each(KEEP_FOREVER)('$name is not refused on the credential', async ({ name, args }) => {
    const { client, server } = await connect('00000000-0000-4000-8000-0000000000b2');
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text, name).not.toContain('PM_REQUIRES_DEVICE');
      expect(text.toLowerCase(), name).not.toContain('device');
      expect(text.toLowerCase(), name).not.toContain('paired');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
