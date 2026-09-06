/**
 * ISS-868 / ISS-931 — which `forge_project_pm` actions are reachable over
 * `/mcp`, and whether the refusal is answerable.
 *
 * The gate used to cover all six actions, so a PAT could neither write the
 * dependency graph nor read it, and the refusal named only the condition that
 * failed (ISS-868 fixed both). ISS-931 took the device off `/mcp` entirely and
 * moved the remaining refusal to `assertPmActor`, which two actions reach and
 * nothing passes: `dispatch` and `write_decision` need a `runners` row keyed on
 * a paired device. `set_dependency` came OUT of the gate in the same change —
 * its handler asks for plain project membership and always did.
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

// cm:guard assert the CONDITION and the WAY OUT, not just the code. The bare `PM_REQUIRES_DEVICE` sent callers hunting for a scope that does not exist (ISS-787/ISS-868); since ISS-931 it must additionally say the credential class cannot reach `/mcp` at all, because "pair a device" is no longer a remedy and a caller told to do it would pair one and try again.
it('names the condition and the way out when it refuses write_decision', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c1', 'write_decision');
  expect(text).toContain('PM_REQUIRES_DEVICE');
  expect(text).toContain('capabilities.pm=true');
  expect(text).toContain('no longer');
  expect(text).toContain('not reachable over MCP');
  expect(text).toContain('forge_issues');
  expect(text).toContain('data.relations');
});

// cm:guard `dispatch` answers ISS-895's refusal, NOT the credential one, and the two are not interchangeable. `dispatchPmJob` throws because the staged lane is gone for every project — an operator told "needs a paired device" would pair a box and get the same failure. Put `assertPmActor` in front of dispatch and this case is what goes red.
it('answers dispatch with the reason it is gone, not with the credential', async () => {
  const text = await callAsPat('00000000-0000-4000-8000-0000000000c6', 'dispatch', {
    issueId: '00000000-0000-4000-8000-0000000000cc',
    jobType: 'code',
    reason: 'a job with no lane to run in',
  });
  expect(text).not.toContain('PM_REQUIRES_DEVICE');
  expect(text).toContain('ISS-895');
});

// cm:guard the reachable list in the refusal is DERIVED from PM_ACTIONS (project-authz.ts), so this case is what catches a hand-typed copy: it asserts the four reachable names are advertised and the two unreachable ones are not.
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

// cm:guard `set_dependency` is in THIS list and not the one above, and the two lists are the whole of the ISS-931 decision. Its handler calls `assertPrincipalIsMember`, not `assertPmActor` (ISS-131 moved it off), so gating it refused 651 lifetime calls of live traffic for a capability its own code never asks for. Move it back up and that traffic starts failing again with nothing else going red.
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
