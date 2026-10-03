/**
 * Loopback MCP client for integration tests: a PAT-authed server and client
 * joined by `InMemoryTransport`, its principal built as the HTTP door builds it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** ISS-1179 — `projectSlug` stands in for the `X-Forge-Project-Slug` header. */
export async function connectClientAsPat(patPlaintext: string, projectSlug: string | null = null) {
  const { verifyPat } = await import('../../src/auth/pat.js');
  const { patPrincipalOf } = await import('../../src/auth/pat-principal.js');
  const { createMcpServer } = await import('../../src/mcp/server.js');
  const verified = await verifyPat(patPlaintext);
  if (!verified) throw new Error('test PAT did not verify');
  const principal = patPrincipalOf(verified);
  const ctx = { principal, projectSlug, boundProjectId: principal.boundProjectId };
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
