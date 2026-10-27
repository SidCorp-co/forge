/**
 * A project master opens its promotion merge request itself (catalog-fe, 2026-10-27; the owner's
 * delivery-model rule has the master open the MR to prod and the owner review it at the release).
 * Its pane's forge MCP lists no `forge_source` — delivery left the MCP server for REST on
 * 2026-10-16 — and a call to it answered only `Unknown tool`, so the master and its operator read
 * the act as unreachable and opened the MR with the connection's own GitLab token. The act is REST:
 * the master's checkout credential reaches `POST /api/projects/:id/integrations/source/change-requests`,
 * a viewer is refused by name, and the retired tool names that door instead of falling silent.
 * Against real Postgres, the host a planted GitLab.
 *
 * @direct-test-of packages/core/src/forge-door/retired.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { issueCheckoutCredential } from '../../src/devices/workspace-credential.js';
import type { OpenedChangeRequest } from '../../src/integrations/source-host/types.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const world = { projectId: '', otherId: '', ownerId: '', bindingId: '' };
const opened: Array<{ head: string; base: string; title: string }> = [];

const planted = {
  provider: 'gitlab' as const,
  get bindingId() {
    return world.bindingId;
  },
  fullName: 'sidcorp-it/catalog-admin-fe',
  host: 'gitlab.example',
  words: { changeRequest: 'merge request', sigil: '!', mergeMethods: ['merge', 'squash'] },
  openChangeRequest: async (args: { head: string; base: string; title: string }) => {
    opened.push(args);
    const mr: OpenedChangeRequest = {
      number: 40 + opened.length,
      url: `https://gitlab.example/sidcorp-it/catalog-admin-fe/-/merge_requests/${40 + opened.length}`,
      title: args.title,
      state: 'open',
      draft: false,
      headRef: args.head,
      headSha: 'a1'.repeat(20),
      baseRef: args.base,
      baseSha: 'b'.repeat(40),
      updatedAt: '2026-10-27T08:00:00.000Z',
    };
    return mr;
  },
};

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => planted,
  sourceHostForBinding: async () => planted,
}));

const PROMOTION = { head: 'release/stg', base: 'main', title: 'Promote release/stg to production' };
const door = (projectId: string) =>
  `/api/projects/${projectId}/integrations/source/change-requests`;

/** The credential a master pane holds: its provisioned checkout's, minted as the project's agent. */
async function masterToken(projectId: string): Promise<string> {
  const deviceId = await createTestDevice(world.ownerId);
  await bindTestRunner(projectId, deviceId);
  await mintPat({
    userId: world.ownerId,
    name: deviceTokenNameFor(deviceId),
    permissions: ['*'],
    deviceId,
  });
  return issueCheckoutCredential({ deviceId, projectId, holderUserId: world.ownerId });
}

async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

const codes = (body: unknown): string[] =>
  ((body as { error?: { refusals?: { code: string }[] } }).error?.refusals ?? []).map(
    (r) => r.code,
  );

beforeEach(async () => {
  await truncateAll();
  opened.length = 0;
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  world.otherId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  await addProjectMember(world.otherId, world.ownerId, 'admin');
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ projectPath: 'sidcorp-it/catalog-admin-fe' })}::jsonb)`);
});

describe("a project master opens its promotion merge request through core, with its pane's credential", () => {
  it('opens it on the host and records it on the projection', async () => {
    const token = await masterToken(world.projectId);
    const res = await api(token, 'POST', door(world.projectId), PROMOTION);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ number: 41, headRef: 'release/stg', baseRef: 'main' });
    expect(opened).toEqual([PROMOTION]);
    const [row] = [
      ...(await db.execute(sql`
        SELECT number, state FROM repo_pull_requests WHERE binding_id = ${world.bindingId}`)),
    ] as Array<{ number: number; state: string }>;
    expect(row).toMatchObject({ number: 41, state: 'open' });
  });

  it("is refused on another project's door, which its credential is not fenced to", async () => {
    const token = await masterToken(world.projectId);
    const res = await api(token, 'POST', door(world.otherId), PROMOTION);
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(opened).toEqual([]);
  });

  it('refuses a viewer of the project by name, and nothing reaches the host', async () => {
    const viewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(world.projectId, viewer, 'viewer');
    const res = await api(await userToken(viewer), 'POST', door(world.projectId), PROMOTION);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain('project.write');
    expect(codes(res.body), JSON.stringify(res.body)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(opened).toEqual([]);
  });
});

describe('the delivery tools that left the MCP server name the door that replaced them', () => {
  it('answers forge_source open_change_request with the REST route, not "Unknown tool"', async () => {
    const token = await masterToken(world.projectId);
    const called = await mcpCall(token, 'forge_source', {
      action: 'open_change_request',
      projectId: world.projectId,
      ...PROMOTION,
    });
    expect(called.isError).toBe(true);
    expect(called.text, 'the retired tool fell silent').not.toContain('Unknown tool');
    expect(called.text).toContain('MCP_DELIVERY_IS_REST');
    expect(called.text).toContain('POST /api/projects/:id/integrations/source/change-requests');
    expect(opened).toEqual([]);
  });

  it.each([
    ['forge_coolify_deploy', '/api/projects/:id/integrations/coolify/'],
    ['forge_sentry', '/api/projects/:id/integrations/sentry/issues'],
    ['forge_storefront_target', '/api/projects/:id/integrations/storefront/target'],
  ])('answers %s with the route that replaced it', async (name, route) => {
    const token = await masterToken(world.projectId);
    const called = await mcpCall(token, name, { action: 'list', projectId: world.projectId });
    expect(called.isError).toBe(true);
    expect(called.text).toContain('MCP_DELIVERY_IS_REST');
    expect(called.text).toContain(route);
  });
});
