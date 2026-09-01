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

const humanPat = (tokenId: string) =>
  ({
    kind: 'pat',
    agency: 'human',
    userId: fakeDevice.ownerId,
    tokenId,
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
  }) as const;

// cm:guard the registered surface is FROZEN here, and ISS-894 is why: the plan is to shrink it to the session-lifecycle group, and nothing went red when a tool was added or removed — so the list drifted in silence in both directions. Adding a tool is a decision; make it visible by editing this array in the same commit, and say in the message which wave it belongs to. A tool deleted without its callers moved is the other half, and `mcp_audit_log` is the authority on whether it had any.
const REGISTERED_TOOLS = [
  'forge_agent_sessions.get',
  'forge_agent_sessions.list',
  'forge_collaborators',
  'forge_comments',
  'forge_config',
  'forge_coolify_deploy',
  'forge_feedback',
  'forge_guide',
  'forge_health',
  'forge_issues',
  'forge_jobs.cancel',
  'forge_jobs.events',
  'forge_jobs.get',
  'forge_jobs.list',
  'forge_jobs.resume',
  'forge_knowledge',
  'forge_memory.delete',
  'forge_memory.feedback',
  'forge_memory.get',
  'forge_memory.search',
  'forge_memory.write',
  'forge_metrics.project_retry_rescues',
  'forge_metrics.project_step_durations',
  'forge_metrics.project_timeseries',
  'forge_metrics.session_failures',
  'forge_metrics.step_durations',
  'forge_orgs.list',
  'forge_orgs.members',
  'forge_phase',
  'forge_pipeline_runs.get',
  'forge_pm.set_dependency',
  'forge_project_pipeline_runs',
  'forge_project_pm',
  'forge_projects.create',
  'forge_projects.get',
  'forge_projects.list',
  'forge_projects.update',
  'forge_reconcile',
  'forge_runners',
  'forge_schedules',
  'forge_skill_facts.get',
  'forge_skill_facts.list',
  'forge_skills.adopt',
  'forge_skills.create',
  'forge_skills.delete',
  'forge_skills.effective',
  'forge_skills.get',
  'forge_skills.list',
  'forge_skills.list_registrations',
  'forge_skills.pin',
  'forge_skills.push',
  'forge_skills.register',
  'forge_skills.sync_status',
  'forge_skills.update',
  'forge_steer',
  'forge_step_handoff.delete',
  'forge_step_handoff.get',
  'forge_step_handoff.write',
  'forge_step_start',
  'forge_storefront_target',
  'forge_uploads',
  'forge_ux_findings',
  'forge_ux_improver',
];

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

  // cm:edge lockstep -> packages/core/src/mcp/pm-device-gate.test.ts — this list is the GATED half of forge_project_pm's actions and that file holds the ungated half; an action moved in DEVICE_REQUIRED without moving here leaves both files passing while one of them asserts the opposite of the gate
  it('blocks PAT principal on every gated forge_project_pm action with PM_REQUIRES_DEVICE', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: humanPat('00000000-0000-4000-8000-0000000000ab'),
      device: fakeDevice,
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      for (const action of ['dispatch', 'set_dependency', 'write_decision']) {
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

  // cm:guard the refusal code must stay the literal `PM_REQUIRES_DEVICE`, because that string is the whole signal — ISS-150 Finding #2 was a DEVICE_REQUIRED set keyed with the wrong separator, so the gate never fired at all and every test still passed
  it('rejects PAT principal on forge_pm.* tools with PM_REQUIRES_DEVICE', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      principal: humanPat('00000000-0000-4000-8000-0000000000aa'),
      device: fakeDevice,
      projectSlug: null,
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      // cm:guard `forge_pm.set_dependency` is the last standalone forge_pm.* name, and it must keep the device gate its retired siblings had — it can run decomposeParent, which creates an integration branch, so a PAT reaching it writes git with no runner behind it
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
