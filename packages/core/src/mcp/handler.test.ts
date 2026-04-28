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

vi.mock('../db/client.js', () => ({
  db: {} as unknown,
}));

import type { Device } from '../auth/deviceToken.js';
import { createMcpServer } from './server.js';
import { forgeVersionTool } from './tools/forge-version.js';

const fakeDevice: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  name: 'fake',
  platform: 'linux',
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online',
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

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
    const server = createMcpServer({ device: fakeDevice, projectSlug: null });
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

  it('exposes the full Chunk A+B toolset (legacy Strapi parity)', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_issues')).toBe(true);
      expect(names.has('forge_comments')).toBe(true);
      expect(names.has('forge_config')).toBe(true);
      expect(names.has('forge_tasks')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
