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
  disabledAt: null,
  status: 'online',
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  machineId: null,
  gitCredentialRef: null,
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
    const server = createMcpServer({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
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
      // forge_tasks was folded into forge_issues task sub-actions (ISS-146).
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
      // ISS-146 removed flag_blocker + the standalone escalate tool.
      expect(names.has('forge_pm.flag_blocker')).toBe(false);
      expect(names.has('forge_pm.escalate')).toBe(false);
      // ISS-483 §E#3 retired the zero-reference write_decision shim. The
      // escalate path now lives on the forge_project_pm dispatcher
      // (action=write_decision, with an optional `escalate` object).
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

  // ISS-145 — consolidated action dispatchers must show up in tools/list so
  // callers can migrate without poking at undocumented names.
  it('exposes the ISS-145 action dispatchers', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_project_pipeline_runs')).toBe(true);
      expect(names.has('forge_project_pm')).toBe(true);
      // ISS-483 §E#3 retired the 9 zero-reference shims; the consolidated
      // dispatchers supersede them.
      expect(names.has('forge_pipeline_runs.list')).toBe(false);
      expect(names.has('forge_pm.snapshot')).toBe(false);
      // Only the 2 shims still referenced by skills survive
      // (forge_pipeline_runs.get → forge-skill-audit, forge_pm.set_dependency
      // → forge-plan).
      expect(names.has('forge_pipeline_runs.get')).toBe(true);
      expect(names.has('forge_pm.set_dependency')).toBe(true);
      // Surviving shims must lead with the deprecation marker so `tools/list`
      // callers see the migration target without invoking the tool.
      const shim = res.tools.find((t) => t.name === 'forge_pipeline_runs.get');
      expect(shim?.description).toMatch(/^\[DEPRECATED/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // ISS-145 — PAT principals must be blocked from the consolidated
  // `forge_project_pm` dispatcher at the action level (any of the six
  // device-only actions). Acceptance criterion 7.
  it('blocks PAT principal on every forge_project_pm action with PM_REQUIRES_DEVICE', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: {
        kind: 'pat',
        userId: fakeDevice.ownerId,
        tokenId: '00000000-0000-4000-8000-0000000000ab',
        scopes: ['read', 'write'],
        projectIds: null,
        boundProjectId: null,
      },
      device: fakeDevice,
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      for (const action of [
        'snapshot',
        'graph',
        'runner_load',
        'dispatch',
        'set_dependency',
        'write_decision',
      ]) {
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

  // ISS-150 — PAT principals must be 403'd from forge_pm.* tools with a stable
  // PM_REQUIRES_DEVICE error code. Regression coverage for Finding #2 where
  // the DEVICE_REQUIRED_TOOLS set used the wrong separator characters and
  // never fired.
  it('rejects PAT principal on forge_pm.* tools with PM_REQUIRES_DEVICE', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: {
        kind: 'pat',
        userId: fakeDevice.ownerId,
        tokenId: '00000000-0000-4000-8000-0000000000aa',
        scopes: ['read', 'write'],
        projectIds: null,
        boundProjectId: null,
      },
      device: fakeDevice,
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      // ISS-483 §E#3 retired the other forge_pm.* shims; forge_pm.set_dependency
      // is the lone survivor and must still enforce the device gate for PATs.
      for (const name of ['forge_pm.set_dependency']) {
        const res = await client.callTool({ name, arguments: {} });
        expect(res.isError).toBe(true);
        const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        expect(text).toContain('PM_REQUIRES_DEVICE');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
