/**
 * ISS-1229 r50, judge-152 on criterion 486: two people with no display name read as two identical rows in a
 * room, so the person taking one out could not tell which. Core answers what tells them apart and nothing that
 * the ruling forbids: each person's role on the room's project, and whether they opened it.
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
type Member = {
  id: string;
  kind: string;
  userId: string | null;
  roles: Array<{ projectId: string; role: string | null }>;
  opener: boolean;
};

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
let projectId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

let viewerId: string;
let memberId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  openerId = await verifiedUser();
  viewerId = await verifiedUser();
  memberId = await verifiedUser();
  const orgId = (await seedOrg(harness.db, openerId)).id;
  for (const id of [viewerId, memberId]) {
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
    );
  }
  projectId = (await createTestProject(harness.db, openerId, { slug: 'desk', name: 'Desk', orgId }))
    .id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${viewerId}, 'viewer'), (${projectId}, ${memberId}, 'member')`,
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

describe("a room's people, told apart by what core answers (ISS-1229 r50, criteria 486 and 492)", () => {
  it("carries each person's role on the room's project and whether they opened it, on the room and after a removal", async () => {
    const opened = await as(openerId, '/api/conversations', 'POST', {
      projectId,
      people: [viewerId, memberId],
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const { id } = (await opened.json()) as { id: string };

    const read = await as(memberId, `/api/conversations/${id}`);
    expect(read.status, await read.clone().text()).toBe(200);
    const all = ((await read.json()) as { participants: Member[] }).participants;
    const people = all.filter((p) => p.kind === 'person');
    const of = (userId: string) => people.find((p) => p.userId === userId);
    expect(of(openerId)).toMatchObject({ roles: [{ projectId, role: 'admin' }], opener: true });
    expect(of(viewerId)).toMatchObject({ roles: [{ projectId, role: 'viewer' }], opener: false });
    expect(of(memberId)).toMatchObject({ roles: [{ projectId, role: 'member' }], opener: false });
    for (const agent of all.filter((p) => p.kind === 'handle')) {
      expect(agent).toMatchObject({ roles: [], opener: false });
    }

    // The membership answer a removal returns carries the same, so the list it redraws tells them apart too.
    const viewerRow = of(viewerId)?.id as string;
    const removed = await as(
      openerId,
      `/api/conversations/${id}/participants/${viewerRow}`,
      'DELETE',
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    const left = ((await removed.json()) as { participants: Member[] }).participants.filter(
      (p) => p.kind === 'person',
    );
    expect(left.map((p) => [p.userId, p.roles[0]?.role, p.opener]).sort()).toEqual(
      [
        [openerId, 'admin', true],
        [memberId, 'member', false],
      ].sort(),
    );
  });
});
