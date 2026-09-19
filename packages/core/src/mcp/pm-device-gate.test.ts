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

import { makeFakePrincipal } from './fake-principal.fixture.js';
import { createMcpServer } from './server.js';

const fakePrincipal = makeFakePrincipal(
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
);

const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

async function callAsPat(
  tokenId: string,
  action: string,
  extraArgs: Record<string, unknown> = {},
): Promise<string> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    principal: makeFakePrincipal(tokenId, fakePrincipal.userId),
    projectSlug: null,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const res = await client.callTool({
      name: 'forge_project_pm',
      arguments: { action, projectId: PROJECT_ID, ...extraArgs },
    });
    return (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  } finally {
    await client.close();
    await server.close();
  }
}

it('names the condition and the way out when it refuses write_decision', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c1', 'write_decision');
  expect(text).toContain('PM_REQUIRES_DEVICE');
  expect(text).toContain('capabilities.pm=true');
  expect(text).toContain('no longer');
  expect(text).toContain('not reachable over MCP');
  expect(text).toContain('forge_issues');
  expect(text).toContain('data.relations');
});

it('answers dispatch with the reason it is gone, not with the credential', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c6', 'dispatch', {
    issueId: '00000000-0000-4000-8000-0000000000cc',
    jobType: 'code',
    reason: 'a job with no lane to run in',
  });
  expect(text).not.toContain('PM_REQUIRES_DEVICE');
  expect(text).toContain('ISS-895');
});

it('advertises exactly the actions that are reachable', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c5', 'write_decision');
  const advertised = /These forge_project_pm actions do work here: ([^.]*)\./.exec(text)?.[1] ?? '';
  expect(advertised.split(', ').sort()).toEqual([
    'graph',
    'runner_load',
    'set_dependency',
    'snapshot',
  ]);
});

it('refuses write_decision, the one action left that needs runner state', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c2', 'write_decision');
  expect(text).toContain('PM_REQUIRES_DEVICE');
});

it('lets a token past the gate on every action that needs no runner state', async () => {
  for (const action of ['snapshot', 'graph', 'runner_load', 'set_dependency']) {
    const text = await callAsPat('00000000-0000-4000-8000-0000000000c3', action);
    expect(text, `action=${action}`).not.toContain('PM_REQUIRES_DEVICE');
  }
});

it('no longer gates the deprecated forge_pm.set_dependency shim', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    principal: makeFakePrincipal('00000000-0000-4000-8000-0000000000c4', fakePrincipal.userId),
    projectSlug: null,
  });
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    const res = await client.callTool({ name: 'forge_pm.set_dependency', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(res.isError).toBe(true);
    expect(text).not.toContain('PM_REQUIRES_DEVICE');
  } finally {
    await client.close();
    await server.close();
  }
});
