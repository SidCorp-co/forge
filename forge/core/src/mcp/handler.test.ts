import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';
import { forgeVersionTool } from './tools/forge-version.js';

describe('forgeVersionTool', () => {
  it('returns version and uptime', async () => {
    const result = (await forgeVersionTool.handler({})) as {
      version: string;
      uptimeSeconds: number;
    };
    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
    expect(typeof result.uptimeSeconds).toBe('number');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('@forge/core MCP server', () => {
  async function connectClient() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return { client, server };
  }

  it('lists the forge_version tool', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const tool = res.tools.find((t) => t.name === 'forge_version');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('version');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('calls forge_version and returns { version, uptimeSeconds }', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.callTool({ name: 'forge_version', arguments: {} });
      const content = res.content as Array<{ type: string; text: string }>;
      const first = content[0];
      expect(first?.type).toBe('text');
      const parsed = JSON.parse(first?.text ?? '');
      expect(typeof parsed.version).toBe('string');
      expect(typeof parsed.uptimeSeconds).toBe('number');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns isError for unknown tool', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.callTool({ name: 'does_not_exist', arguments: {} });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
