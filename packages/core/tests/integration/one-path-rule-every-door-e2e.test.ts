/**
 * ISS-1236 r6 — judge-140 at a90f24b: `forge_projects.create` and `forge_projects.update` stored a
 * relative `repoPath` that `PATCH /api/projects/:id` refuses with `REPO_PATH_NOT_ABSOLUTE`, and a
 * device's own runner PATCH (what `forge-runner bind` calls) stored one too, as the path its runs
 * would work in. Every door that writes a `repoPath` now refuses a relative one by that code and
 * sentence, writing nothing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repoPathRefusal } from '../../src/lib/absolute-path.js';
import { callRest, callTool } from '../helpers/door-parity.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let ownerId: string;
let projectId: string;
let jwt: string;
let pat: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await harness.db.execute(
    sql`UPDATE projects SET repo_path_hint = '/srv/kept' WHERE id = ${projectId}`,
  );
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  jwt = await signUserToken(owner.id);
  pat = (await mintPat({ userId: owner.id, name: 'owner', scopes: ['read', 'write', 'admin'] }))
    .plaintext;
});

async function hintOf(id: string): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT repo_path_hint AS hint FROM projects WHERE id = ${id}`,
  )) as unknown as Array<{ hint: string | null }>;
  return rows[0]?.hint ?? null;
}

/** What an MCP door answers: the code, then the sentence REST answers for the same path. */
async function orgOf(id: string): Promise<string> {
  const rows = (await harness.db.execute(
    sql`SELECT org_id FROM projects WHERE id = ${id}`,
  )) as unknown as Array<{ org_id: string }>;
  return rows[0]?.org_id as string;
}

async function idOf(slug: string): Promise<string> {
  const rows = (await harness.db.execute(
    sql`SELECT id FROM projects WHERE slug = ${slug}`,
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id as string;
}

const REFUSED = (path: string) => `REPO_PATH_NOT_ABSOLUTE: ${repoPathRefusal(path)}`;

/** A REST refusal's code and sentence. */
const restRefusal = (res: { refused?: string }) =>
  JSON.parse(res.refused ?? '{}') as { code?: string; message?: string };

describe('the project checkout hint, at every door', () => {
  it('PATCH /api/projects/:id refuses a relative repoPath by code and sentence', async () => {
    const res = await callRest(server.baseUrl, jwt, 'PATCH', `/api/projects/${projectId}`, {
      repoPath: 'relative/x',
    });
    expect(res.status).toBe(400);
    expect(restRefusal(res)).toMatchObject({
      code: 'REPO_PATH_NOT_ABSOLUTE',
      message: repoPathRefusal('relative/x'),
    });
    expect(await hintOf(projectId)).toBe('/srv/kept');
  });

  it('forge_projects.update refuses it with the same code and sentence, writing nothing', async () => {
    const res = await callTool(pat, 'forge_projects.update', {
      projectId,
      patch: { repoPath: 'relative/y' },
    });
    expect(res.refused).toContain(REFUSED('relative/y'));
    expect(await hintOf(projectId)).toBe('/srv/kept');
  });

  it('forge_projects.create refuses it with the same code and sentence, creating no project', async () => {
    const res = await callTool(pat, 'forge_projects.create', {
      slug: 'relative-hint',
      name: 'Relative hint',
      orgId: await orgOf(projectId),
      repoPath: 'relative/z',
    });
    expect(res.refused).toContain(REFUSED('relative/z'));
    const rows = (await harness.db.execute(
      sql`SELECT id FROM projects WHERE slug = 'relative-hint'`,
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('still takes an absolute path and an empty one at the MCP doors', async () => {
    const updated = await callTool(pat, 'forge_projects.update', {
      projectId,
      patch: { repoPath: '/srv/moved' },
    });
    expect(updated.refused).toBeUndefined();
    expect(await hintOf(projectId)).toBe('/srv/moved');
    const created = await callTool(pat, 'forge_projects.create', {
      slug: 'absolute-hint',
      name: 'Absolute hint',
      orgId: await orgOf(projectId),
      repoPath: '/srv/created',
    });
    expect(created.refused).toBeUndefined();
    expect(await hintOf(await idOf('absolute-hint'))).toBe('/srv/created');

    const emptied = await callTool(pat, 'forge_projects.update', {
      projectId,
      patch: { repoPath: '' },
    });
    expect(emptied.refused).toBeUndefined();
    expect(await hintOf(projectId)).toBe('');
    const createdEmpty = await callTool(pat, 'forge_projects.create', {
      slug: 'empty-hint',
      name: 'Empty hint',
      orgId: await orgOf(projectId),
      repoPath: '',
    });
    expect(createdEmpty.refused).toBeUndefined();
    expect(await hintOf(await idOf('empty-hint'))).toBe('');
  });
});

describe("a device's own runner binding", () => {
  async function bound(): Promise<{ runnerId: string; deviceToken: string }> {
    const { pairDevice } = await import('../helpers/pair-device.js');
    const { device, plaintext } = await pairDevice({
      ownerId,
      name: 'box-one',
      platform: 'linux',
    });
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, repo_path)
      VALUES (${runnerId}, ${projectId}, 'claude-code', ${device.id}, 'box-one', 'offline', '/srv/box')
    `);
    return { runnerId, deviceToken: plaintext };
  }

  async function repoPathOf(runnerId: string): Promise<string | null> {
    const rows = (await harness.db.execute(
      sql`SELECT repo_path FROM runners WHERE id = ${runnerId}`,
    )) as unknown as Array<{ repo_path: string | null }>;
    return rows[0]?.repo_path ?? null;
  }

  it('refuses a relative repoPath with 400 REPO_PATH_NOT_ABSOLUTE and leaves the row', async () => {
    const { runnerId, deviceToken } = await bound();
    const res = await callRest(
      server.baseUrl,
      deviceToken,
      'PATCH',
      `/api/devices/me/runners/${runnerId}`,
      {
        repoPath: 'checkouts/app',
      },
    );
    expect(res.status).toBe(400);
    expect(restRefusal(res)).toMatchObject({
      code: 'REPO_PATH_NOT_ABSOLUTE',
      message: repoPathRefusal('checkouts/app'),
    });
    expect(await repoPathOf(runnerId)).toBe('/srv/box');
  });

  it('still takes an absolute path', async () => {
    const { runnerId, deviceToken } = await bound();
    const res = await callRest(
      server.baseUrl,
      deviceToken,
      'PATCH',
      `/api/devices/me/runners/${runnerId}`,
      {
        repoPath: '/srv/elsewhere',
      },
    );
    expect(res.status).toBe(200);
    expect(await repoPathOf(runnerId)).toBe('/srv/elsewhere');
  });
});
