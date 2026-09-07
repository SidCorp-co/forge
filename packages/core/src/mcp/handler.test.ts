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
    agency: 'human',
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
      // cm:guard `forge_tasks` must NOT come back as a tool — ISS-146 folded it into `forge_issues` as the createTask/listTasks/updateTask/deleteTask sub-actions, which is why the four assertions below read the DESCRIPTION rather than the tool list
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
      // cm:guard escalation has exactly one route: `forge_project_pm` action=write_decision with an optional `escalate` object. ISS-146 removed `flag_blocker` and the standalone `escalate` tool, ISS-483 §E#3 the `write_decision` shim — re-registering any of the three gives escalation a second door, and the dispatcher assertion below stops describing the only way in.
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

  // cm:guard the dispatchers must appear in `tools/list`: it is the only place a caller of a retired shim can find what replaced it, so a dispatcher that exists but is not listed leaves the migration undiscoverable (ISS-145)
  it('exposes the ISS-145 action dispatchers', async () => {
    const { client, server } = await connectClient();
    try {
      const res = await client.listTools();
      const names = new Set(res.tools.map((t) => t.name));
      expect(names.has('forge_project_pipeline_runs')).toBe(true);
      expect(names.has('forge_project_pm')).toBe(true);
      expect(names.has('forge_pipeline_runs.list')).toBe(false);
      expect(names.has('forge_pm.snapshot')).toBe(false);
      // cm:guard exactly two legacy names stay registered, and only because a live skill calls each by name — forge-skill-audit for `forge_pipeline_runs.get`, forge-plan/forge-triage/forge-build for `forge_pm.set_dependency`. Registering a third re-opens a second path into a dispatcher action; dropping one of these two breaks that skill's next run with `Unknown tool`, which is why both directions are asserted.
      expect(names.has('forge_pipeline_runs.get')).toBe(true);
      expect(names.has('forge_pm.set_dependency')).toBe(true);
      // cm:guard a surviving shim's description must LEAD with the marker, so `tools/list` alone tells a caller where to go; make it a suffix and the migration target is only discoverable by invoking the tool that is going away
      const shim = res.tools.find((t) => t.name === 'forge_pipeline_runs.get');
      expect(shim?.description).toMatch(/^\[DEPRECATED/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // cm:edge lockstep -> packages/core/src/mcp/pm-device-gate.test.ts — this list is the CREDENTIAL-refused half of forge_project_pm's actions and that file holds the reachable half plus dispatch, which answers ISS-895 instead; an action that changes side without moving in both leaves both files passing while one asserts the opposite of the gate
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

  // cm:guard the refusal code must stay the literal `PM_REQUIRES_DEVICE`, because that string is the whole signal — ISS-150 Finding #2 was a gate keyed with the wrong separator, so it never fired at all and every test still passed
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
      // cm:guard `forge_pm.set_dependency` is the last standalone forge_pm.* name and it is NOT credential-gated. It carried the device gate its retired siblings had, on the stated ground that it "can run decomposeParent, which creates an integration branch, so a PAT reaching it writes git with no runner behind it" — that capability is gone (`decomposeParent` is nowhere in the tree) and `setIssueDependency` writes a row and emits hooks. The same edges were reachable to any token through `forge_issues data.relations`, which the refusal itself advertised, so the gate was a detour rather than a fence (ISS-931).
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
