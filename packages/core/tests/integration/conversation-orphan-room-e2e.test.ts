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
  // The web transport, registered as the drain registers it at boot, so a room's shape follows who is
  // in it: two people make a group, one person and an agent a one-to-one room.
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  registerConversationTransport(webConversationPorts);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let creatorId: string;
let memberId: string;
let peerId: string;
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
  peerId = await verifiedUser();
  orgId = (await seedOrg(harness.db, ownerId)).id;
  for (const id of [creatorId, memberId, peerId]) {
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
    );
  }
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'billing', name: 'Billing', orgId })
  ).id;
  for (const id of [creatorId, peerId]) {
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${id}, 'member')`,
    );
  }
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

/** A room the creator opens in the project, which is then deleted under it: one-to-one with the
 *  project's agent, or a group where `withPeer` brings a second person in. */
async function roomWhoseProjectIsGone(withPeer = false): Promise<string> {
  const opened = await as(creatorId, '/api/conversations', 'POST', {
    projectId,
    title: 'Release chat',
    ...(withPeer ? { people: [peerId] } : {}),
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

type ListedRoom = {
  id: string;
  deletedProjectNames: string[];
  createdAt: string;
  lastMessageAt: string | null;
};

const rows = async (userId: string, under = orgId): Promise<ListedRoom[]> => {
  const res = await as(userId, `/api/orgs/${under}/rooms-without-a-project`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ListedRoom[];
};

const listedUnder = async (userId: string, under: string): Promise<string[]> =>
  (await rows(userId, under)).map((r) => r.id);

const listed = (userId: string): Promise<string[]> => listedUnder(userId, orgId);

describe('a room whose project was deleted', () => {
  it('stays its organization’s, and its creator finds it and deletes it', async () => {
    const id = await roomWhoseProjectIsGone();

    expect(await listed(creatorId)).toEqual([id]);
    const res = await as(creatorId, `/api/conversations/${id}`, 'DELETE');
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  it('is found and deleted by an admin of its organization who was never in it', async () => {
    const id = await roomWhoseProjectIsGone(true);

    expect(await listed(ownerId)).toEqual([id]);
    const res = await as(ownerId, `/api/conversations/${id}`, 'DELETE');
    expect(res.status, await res.clone().text()).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  it('is neither listed to nor deletable by a member of the organization who did not open it', async () => {
    const id = await roomWhoseProjectIsGone(true);

    expect(await listed(memberId)).toEqual([]);
    const res = await as(memberId, `/api/conversations/${id}`, 'DELETE');
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      details?: { conversationId?: string };
    };
    expect(res.status).toBe(403);
    expect(body.code).toBe('CONVERSATION_NO_SCOPE');
    expect(body.message).toMatch(
      /only the person who opened it or an admin of its organization can reach it/,
    );
    // Round 27, judge-77: the sentence a person reads says "This room" and never the room's id.
    expect(body.message).toMatch(/^This room has no agent in it, so it is about no project;/);
    expect(body.message).not.toContain(id);
    expect(body.details?.conversationId).toBe(id);
    expect(await roomExists(id)).toBe(true);
  });

  // ISS-1229 r25, judge-72: an admin was listed a member's one-to-one room, offered Delete, and refused
  // its read. The master's ruling: a one-to-one room is its people's alone, listed, read and deleted.
  it('is listed, read and deleted by the people in it alone where it is one-to-one', async () => {
    const id = await roomWhoseProjectIsGone();

    expect(await listed(ownerId)).toEqual([]);
    expect(await listed(creatorId)).toEqual([id]);
    expect((await as(ownerId, `/api/conversations/${id}`)).status).toBe(403);
    const res = await as(ownerId, `/api/conversations/${id}`, 'DELETE');
    const body = (await res.json()) as { code?: string; message?: string };
    expect(res.status).toBe(403);
    expect(body.message).toMatch(/it is a one-to-one room, so only the people in it can reach it/);
    expect(body.message).not.toMatch(/admin/);
    expect(body.message).not.toContain(id);
    expect(await roomExists(id)).toBe(true);
    expect((await as(creatorId, `/api/conversations/${id}`)).status).toBe(200);
    expect((await as(creatorId, `/api/conversations/${id}`, 'DELETE')).status).toBe(204);
  });

  it('is still listed to and read by an admin of its organization where it is a group', async () => {
    const id = await roomWhoseProjectIsGone(true);

    expect(await listed(ownerId)).toEqual([id]);
    expect((await as(ownerId, `/api/conversations/${id}`)).status).toBe(200);
  });

  it('takes no message, refused by name, rather than answering under no project', async () => {
    const id = await roomWhoseProjectIsGone();

    const res = await as(creatorId, `/api/conversations/${id}/messages`, 'POST', { content: 'hi' });
    expect(res.status).toBe(409);
  });

  // Consult F1: 0350 finds no organization for a room whose projects were gone before it ran. Round 24:
  // it is listed under its opener's personal workspace alone, never under every organization they read.
  it('stays its opener’s to find and delete where no organization is recorded for it', async () => {
    const id = await roomWhoseProjectIsGone(true);
    const personal = (await seedOrg(harness.db, creatorId, { isPersonal: true })).id;
    await harness.db.execute(sql`UPDATE conversations SET org_id = NULL WHERE id = ${id}`);

    expect(await listed(creatorId)).toEqual([]);
    expect(await listedUnder(creatorId, personal)).toEqual([id]);
    expect(await listed(ownerId)).toEqual([]);
    const refused = await as(ownerId, `/api/conversations/${id}`, 'DELETE');
    expect(refused.status).toBe(403);
    // Round 25: the refusal names only who can reach it; no organization holds it, so no admin can.
    const { message } = (await refused.json()) as { message: string };
    expect(message).toMatch(
      /no organization holds it, so only the person who opened it can reach it/,
    );
    expect(message).not.toMatch(/admin/);
    expect((await as(creatorId, `/api/conversations/${id}`, 'DELETE')).status).toBe(204);
    expect(await roomExists(id)).toBe(false);
  });

  // Review F1: the opener who has since left the organization still finds it, under one they hold.
  // Round 24: under their personal workspace alone, while the organization's admins still find it.
  it('stays findable by its opener after they leave its organization', async () => {
    const id = await roomWhoseProjectIsGone(true);
    const elsewhere = (await seedOrg(harness.db, creatorId)).id;
    const personal = (await seedOrg(harness.db, creatorId, { isPersonal: true })).id;
    await harness.db.execute(
      sql`DELETE FROM organization_members WHERE org_id = ${orgId} AND user_id = ${creatorId}`,
    );

    expect(await listedUnder(creatorId, elsewhere)).toEqual([]);
    expect(await listedUnder(creatorId, personal)).toEqual([id]);
    expect(await listed(ownerId)).toEqual([id]);
    expect((await as(creatorId, `/api/conversations/${id}`, 'DELETE')).status).toBe(204);
  });

  // Round 24: a row tells its room apart — the project that went, when it was opened, its last word.
  it('names the project that was deleted, when the room was opened and when it was last spoken in', async () => {
    const opened = await as(creatorId, '/api/conversations', 'POST', {
      projectId,
      title: 'Release chat',
    });
    const { id } = (await opened.json()) as { id: string };
    await harness.db.execute(
      sql`INSERT INTO conversation_messages (conversation_id, seq, role, content, created_at)
          VALUES (${id}, 1, 'user', 'hello', '2026-10-03T09:15:00Z')`,
    );
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    const [row] = await rows(creatorId);
    expect(row?.id).toBe(id);
    expect(row?.deletedProjectNames).toEqual(['Billing']);
    expect(typeof row?.createdAt).toBe('string');
    expect(row?.lastMessageAt).toBe('2026-10-03T09:15:00.000Z');
  });

  it('records the project through the project delete route too, and says nothing was said in an empty room', async () => {
    const opened = await as(creatorId, '/api/conversations', 'POST', { projectId });
    const { id } = (await opened.json()) as { id: string };
    const gone = await as(ownerId, `/api/projects/${projectId}`, 'DELETE');
    expect(gone.status, await gone.clone().text()).toBe(204);

    const [row] = await rows(creatorId);
    expect(row).toMatchObject({ id, deletedProjectNames: ['Billing'], lastMessageAt: null });
  });

  it('records no name for a room orphaned before 0353 kept them', async () => {
    const id = await roomWhoseProjectIsGone();
    await harness.db.execute(
      sql`UPDATE conversations SET deleted_project_names = '{}' WHERE id = ${id}`,
    );
    const [row] = await rows(creatorId);
    expect(row?.deletedProjectNames).toEqual([]);
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
