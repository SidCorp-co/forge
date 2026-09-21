/**
 * Loopback MCP client for integration tests: a PAT-authed server and client
 * joined by `InMemoryTransport`, plus the tool-result decoder.
 *
 * Lifted out of `mcp-tools.test.ts` so a new MCP test does not have to grow
 * that file's single 390-line `describe` body to reuse them.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

export async function connectClientAsPat(patPlaintext: string) {
  const { verifyPat } = await import('../../src/auth/pat.js');
  const { createMcpServer } = await import('../../src/mcp/server.js');
  const verified = await verifyPat(patPlaintext);
  if (!verified) throw new Error('test PAT did not verify');
  const { row } = verified;
  const ctx = {
    principal: {
      kind: 'pat' as const,
      agency: verified.ownerKind,
      agentUserId: verified.ownerKind === 'agent' ? row.userId : null,
      userId: row.userId,
      tokenId: row.id,
      scopes: row.scopes,
      projectIds: row.projectIds ?? null,
      boundProjectId: row.boundProjectId ?? null,
      deviceId: row.deviceId ?? null,
    },
    projectSlug: null,
    boundProjectId: row.boundProjectId ?? null,
  };
  const server = createMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    server,
    principal: ctx.principal,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The JSON a tool returned, or a throw when it answered with anything else. */
export function parseToolResult(res: { content: Array<{ type: string; text: string }> }): unknown {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected text content');
  return JSON.parse(first.text);
}
