/**
 * ISS-868 — which credential class reaches which `forge_project_pm` action,
 * and whether the refusal is answerable. The gate used to cover all six
 * actions, so a PAT could neither write the dependency graph nor read it, and
 * the refusal text named only the condition that failed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';

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

import { makeFakeDevice } from './fake-device.fixture.js';
import { createMcpServer } from './server.js';

const fakeDevice = makeFakeDevice(
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
);

const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

async function callAsPat(tokenId: string, action: string): Promise<string> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    principal: {
      kind: 'pat',
      agency: 'human',
      userId: fakeDevice.ownerId,
      tokenId,
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
    const res = await client.callTool({
      name: 'forge_project_pm',
      arguments: { action, projectId: PROJECT_ID },
    });
    return (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  } finally {
    await client.close();
    await server.close();
  }
}

it('names the condition to satisfy and a reachable alternative when it refuses a PAT', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c1', 'set_dependency');
  expect(text).toContain('PM_REQUIRES_DEVICE');
  expect(text).toContain('paired-device token');
  expect(text).toContain('forge-runner login');
  expect(text).toContain('forge_issues');
  expect(text).toContain('data.relations');
});

it('still refuses a PAT on every action that needs runner state', async () => {
  for (const action of ['dispatch', 'set_dependency', 'write_decision']) {
    const text = await callAsPat('00000000-0000-4000-8000-0000000000c2', action);
    expect(text, `action=${action}`).toContain('PM_REQUIRES_DEVICE');
  }
});

it('lets a PAT past the gate on the read-only actions so it can read the graph', async () => {
  for (const action of ['snapshot', 'graph', 'runner_load']) {
    const text = await callAsPat('00000000-0000-4000-8000-0000000000c3', action);
    expect(text, `action=${action}`).not.toContain('PM_REQUIRES_DEVICE');
  }
});

it('refuses the deprecated forge_pm.set_dependency shim the same way', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    principal: {
      kind: 'pat',
      agency: 'human',
      userId: fakeDevice.ownerId,
      tokenId: '00000000-0000-4000-8000-0000000000c4',
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
    const res = await client.callTool({ name: 'forge_pm.set_dependency', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(res.isError).toBe(true);
    expect(text).toContain('PM_REQUIRES_DEVICE');
    expect(text).toContain('data.relations');
  } finally {
    await client.close();
    await server.close();
  }
});
