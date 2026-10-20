/**
 * ISS-1229 r23 — judge-66 deleted a project and the room opened in it was about no project, so every
 * door refused it with CONVERSATION_NO_SCOPE, its creator's included, and nobody could ever delete it
 * (room 0205a321 on beta). The master's ruling: the room survives as its organization's, and its
 * creator or whoever holds the organization's admin role can delete it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let creatorId: string;
let memberId: string;
let orgId: string;
let projectId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  creatorId = await verifiedUser();
  memberId = await verifiedUser();
  orgId = (await seedOrg(harness.db, ownerId)).id;
  for (const id of [creatorId, memberId]) {
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
    );
  }
  projectId = (await createTestProject(harness.db, ownerId, { slug: 'billing', orgId })).id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${creatorId}, 'member')`,
  );
});

async function as(userId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A room the creator opens in the project, which is then deleted under it. */
async function roomWhoseProjectIsGone(): Promise<string> {
  const opened = await as(creatorId, '/api/conversations', 'POST', {
    projectId,
    title: 'Release chat',
  });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const { id } = (await opened.json()) as { id: string };
  await harness.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
  return id;
}

async function roomExists(id: string): Promise<boolean> {
  const rows = await harness.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM conversations WHERE id = ${id}`,
  );
  return Number(rows[0]?.n) === 1;
}

const listed = async (userId: string): Promise<string[]> => {
  const res = await as(userId, `/api/orgs/${orgId}/rooms-without-a-project`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
};

describe('a room whose project was deleted', () => {
  it('stays its organization’s, and its creator finds it and deletes it', async () => {
    const id = await roomWhoseProjectIsGone();

    expect(await listed(creatorId)).toEqual([id]);
    const res = await as(creatorId, `/api/conversations/${id}`, 'DELETE');
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  it('is found and deleted by an admin of its organization who was never in it', async () => {
    const id = await roomWhoseProjectIsGone();

    expect(await listed(ownerId)).toEqual([id]);
    const res = await as(ownerId, `/api/conversations/${id}`, 'DELETE');
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  it('is neither listed to nor deletable by a member of the organization who did not open it', async () => {
    const id = await roomWhoseProjectIsGone();

    expect(await listed(memberId)).toEqual([]);
    const res = await as(memberId, `/api/conversations/${id}`, 'DELETE');
    const body = (await res.json()) as { code?: string; message?: string };
    expect(res.status).toBe(403);
    expect(body.code).toBe('CONVERSATION_NO_SCOPE');
    expect(body.message).toMatch(/opened it or an admin of its organization/);
    expect(await roomExists(id)).toBe(true);
  });

  it('takes no message, refused by name, rather than answering under no project', async () => {
    const id = await roomWhoseProjectIsGone();

    const res = await as(creatorId, `/api/conversations/${id}/messages`, 'POST', { content: 'hi' });
    expect(res.status).toBe(409);
  });

  // Consult F1: 0350 finds no organization for a room whose projects were gone before it ran.
  it('stays its opener’s to find and delete where no organization is recorded for it', async () => {
    const id = await roomWhoseProjectIsGone();
    await harness.db.execute(sql`UPDATE conversations SET org_id = NULL WHERE id = ${id}`);

    expect(await listed(creatorId)).toEqual([id]);
    expect(await listed(ownerId)).toEqual([]);
    expect((await as(ownerId, `/api/conversations/${id}`, 'DELETE')).status).toBe(403);
    expect((await as(creatorId, `/api/conversations/${id}`, 'DELETE')).status).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  // Review F1: the opener who has since left the organization still finds it, under one they hold.
  it('stays findable by its opener after they leave its organization', async () => {
    const id = await roomWhoseProjectIsGone();
    const elsewhere = (await seedOrg(harness.db, creatorId)).id;
    await harness.db.execute(
      sql`DELETE FROM organization_members WHERE org_id = ${orgId} AND user_id = ${creatorId}`,
    );

    const res = await as(creatorId, `/api/orgs/${elsewhere}/rooms-without-a-project`);
    expect(((await res.json()) as Array<{ id: string }>).map((r) => r.id)).toEqual([id]);
    expect((await as(creatorId, `/api/conversations/${id}`, 'DELETE')).status).toBe(204);
  });

  it('goes with its organization', async () => {
    const id = await roomWhoseProjectIsGone();
    await harness.db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    expect(await roomExists(id)).toBe(false);
  });
});

describe('migration 0350', () => {
  const file = join(
    import.meta.dirname,
    '../../drizzle/migrations/0350_a_room_outlives_its_project.sql',
  );
  const backfill = () => {
    const statements = readFileSync(file, 'utf8').split('--> statement-breakpoint');
    return statements[statements.length - 1] ?? '';
  };

  it('gives a room standing before it its organization and its opener, and re-running changes nothing', async () => {
    const opened = await as(creatorId, '/api/conversations', 'POST', { projectId });
    const { id } = (await opened.json()) as { id: string };
    await harness.db.execute(
      sql`UPDATE conversations SET org_id = NULL, created_by = NULL WHERE id = ${id}`,
    );

    await harness.db.execute(sql.raw(backfill()));
    const read = async () =>
      (
        await harness.db.execute<{ org_id: string | null; created_by: string | null }>(
          sql`SELECT org_id, created_by FROM conversations WHERE id = ${id}`,
        )
      )[0];
    expect(await read()).toEqual({ org_id: orgId, created_by: creatorId });

    await harness.db.execute(sql.raw(backfill()));
    expect(await read()).toEqual({ org_id: orgId, created_by: creatorId });
  });
});
