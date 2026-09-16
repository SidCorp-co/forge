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

import { makeFakePrincipal } from './fake-principal.fixture.js';
import { REGISTERED_TOOLS } from './registered-tools.js';
import { createMcpServer } from './server.js';

const fakePrincipal = makeFakePrincipal(
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
);

const humanPat = (tokenId: string) =>
  ({
    kind: 'pat',
    agency: null,
    agentUserId: null,
    userId: fakePrincipal.userId,
    tokenId,
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    deviceId: null,
    machine: null,
  }) as const;

describe('@forge/core MCP server', () => {
  async function connectClient() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: fakePrincipal,
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return { client, server };
  }

  it('registers exactly the frozen tool surface — no silent additions, no silent removals', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      expect(res.tools.map((t) => t.name).sort()).toEqual([...REGISTERED_TOOLS].sort());
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
      expect(names.has('forge_tasks')).toBe(false);
      const issuesTool = res.tools.find((t) => t.name === 'forge_issues');
      expect(issuesTool?.description ?? '').toContain('createTask');
      expect(issuesTool?.description ?? '').toContain('listTasks');
      expect(issuesTool?.description ?? '').toContain('updateTask');
      expect(issuesTool?.description ?? '').toContain('deleteTask');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not expose retired PM tools (ISS-146 + ISS-483)', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_pm.flag_blocker')).toBe(false);
      expect(names.has('forge_pm.escalate')).toBe(false);
      expect(names.has('forge_pm.write_decision')).toBe(false);
      const dispatcher = res.tools.find((t) => t.name === 'forge_project_pm');
      expect(dispatcher).toBeDefined();
      expect(dispatcher?.description ?? '').toContain('write_decision');
      expect(dispatcher?.description ?? '').toContain('escalate');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes the Phase 1 diagnostic toolset (ISS-7)', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_jobs.list')).toBe(true);
      expect(names.has('forge_jobs.get')).toBe(true);
      expect(names.has('forge_jobs.events')).toBe(true);
      expect(names.has('forge_agent_sessions.list')).toBe(true);
      expect(names.has('forge_agent_sessions.get')).toBe(true);
      expect(names.has('forge_projects.list')).toBe(true);
      expect(names.has('forge_health')).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes the ISS-145 action dispatchers', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_project_pipeline_runs')).toBe(true);
      expect(names.has('forge_project_pm')).toBe(true);
      expect(names.has('forge_pipeline_runs.list')).toBe(false);
      expect(names.has('forge_pm.snapshot')).toBe(false);
      expect(names.has('forge_pipeline_runs.get')).toBe(true);
      expect(names.has('forge_pm.set_dependency')).toBe(true);
      const shim = res.tools.find((t) => t.name === 'forge_pipeline_runs.get');
      expect(shim?.description).toMatch(/^\[DEPRECATED/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('refuses the forge_project_pm action that needs runner state', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: humanPat('00000000-0000-4000-8000-0000000000ab'),
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      for (const action of ['write_decision']) {
        const res = await client.callTool({
          name: 'forge_project_pm',
          arguments: { action, projectId: '00000000-0000-4000-8000-0000000000bb' },
        });
        expect(res.isError, `action=${action}`).toBe(true);
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text, `action=${action}`).toContain('PM_REQUIRES_DEVICE');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lets a token reach the forge_pm.set_dependency shim', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: humanPat('00000000-0000-4000-8000-0000000000aa'),
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      for (const name of ['forge_pm.set_dependency']) {
        const res = await client.callTool({ name, arguments: {} });
        expect(res.isError).toBe(true);
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).not.toContain('PM_REQUIRES_DEVICE');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
