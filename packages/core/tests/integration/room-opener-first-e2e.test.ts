/**
 * ISS-1229 r45, judge-129 — a room opens with all its people in one transaction, so they share one
 * moment, and the web told unnamed people apart by each row's random id: the person who opened the room
 * could read as "the second". Core serves a room's members in one stated order, the opener first among
 * people added at the same moment, and the web keeps the place it was served.
 */

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
type Member = { kind: string; userId: string | null; addedAt: string };

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
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  registerConversationTransport(webConversationPorts);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let openerId: string;
let peers: string[];
let projectId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  openerId = await verifiedUser();
  peers = [await verifiedUser(), await verifiedUser(), await verifiedUser()];
  const orgId = (await seedOrg(harness.db, openerId)).id;
  for (const id of peers) {
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
    );
  }
  projectId = (
    await createTestProject(harness.db, openerId, { slug: 'desk', name: 'Desk', orgId })
  ).id;
  for (const id of peers) {
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

describe("a room's people, added at one moment", () => {
  it('are served with the person who opened the room first, wherever the table keeps its row', async () => {
    const opened = await as(openerId, '/api/conversations', 'POST', { projectId, people: peers });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const { id } = (await opened.json()) as { id: string };

    // The opener's row written again as it was, so the table and its indexes hold it last, where an
    // unordered read returns it.
    await harness.db.execute(
      sql`WITH gone AS (DELETE FROM conversation_participants WHERE conversation_id = ${id} AND user_id = ${openerId} RETURNING *)
          INSERT INTO conversation_participants SELECT * FROM gone`,
    );

    const read = await as(peers[1] as string, `/api/conversations/${id}`);
    expect(read.status, await read.clone().text()).toBe(200);
    const people = ((await read.json()) as { participants: Member[] }).participants.filter(
      (p) => p.kind === 'person',
    );
    expect(new Set(people.map((p) => p.addedAt)).size).toBe(1);
    expect(people[0]?.userId).toBe(openerId);
    expect(people.map((p) => p.userId).sort()).toEqual([openerId, ...peers].sort());
  });
});
