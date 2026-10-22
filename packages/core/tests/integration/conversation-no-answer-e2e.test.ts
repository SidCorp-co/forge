/**
 * ISS-1229 r35 — judge-95 sent the first message in a room whose only agent had lost its role on the
 * project: core stored the message, then answered 500, and nothing ever answered it. Routing the window
 * minted a second agent for the project, outside any transaction, and the mint collided on the handle
 * the first one still holds. A room no agent can answer now refuses the message by name before taking
 * it in, and a window already open for such a project is closed as unreachable, minting nothing.
 *
 * The same judge, a viewer of the project, was invited to open a room there and refused "Not a project
 * member." — which the viewer is. Both doors now name the member role they need and the role held.
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
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

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

let ownerId: string;
let viewerId: string;
let projectId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

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

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  viewerId = await verifiedUser();
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${viewerId}, 'member')`,
  );
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'ledger', name: 'Ledger', orgId })
  ).id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${viewerId}, 'viewer')`,
  );
});

async function roomNobodyAnswers(): Promise<{ id: string; agentId: string }> {
  const opened = await as(ownerId, '/api/conversations', 'POST', { projectId });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const { id } = (await opened.json()) as { id: string };
  const agents = await harness.db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM conversation_participants WHERE conversation_id = ${id} AND kind = 'handle'`,
  );
  const agentId = String(agents[0]?.user_id);
  await harness.db.execute(
    sql`DELETE FROM project_members WHERE project_id = ${projectId} AND user_id = ${agentId}`,
  );
  return { id, agentId };
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return Number((await harness.db.execute<{ n: number }>(query))[0]?.n);
}

describe('a room no agent can answer', () => {
  it('refuses a message by name, naming the agent and the project it lost its role on, and takes nothing in', async () => {
    const { id, agentId } = await roomNobodyAnswers();
    const agentsBefore = await count(
      sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`,
    );

    const res = await as(ownerId, `/api/conversations/${id}/messages`, 'POST', {
      content: 'Hello, which issues are open in this project?',
    });
    const refusal = (await res.json()) as Refusal;
    expect(res.status).toBe(409);
    expect(refusal.code).toBe('CONVERSATION_NO_AGENT_ANSWERS');
    expect(refusal.message).toBe(
      'No agent in this room can answer, so this message was not taken in: @ledger no longer holds a role on Ledger, and answers again once it does.',
    );
    expect(refusal.details).toEqual({ conversationId: id, projectId, agentUserIds: [agentId] });

    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${id}`,
      ),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM conversation_windows WHERE conversation_id = ${id}`,
      ),
    ).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`)).toBe(
      agentsBefore,
    );
  });

  it('closes a window already taken in for it as unreachable, saying why, and mints no second agent', async () => {
    const { id } = await roomNobodyAnswers();
    const agentsBefore = await count(
      sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`,
    );
    const room = (
      await harness.db.execute<{ external_id: string; shape: 'direct' | 'group' }>(
        sql`SELECT external_id, shape FROM conversations WHERE id = ${id}`,
      )
    )[0];
    const { sendWebConversationMessage } = await import('../../src/assistant/conversation-send.js');

    // The door's read and the route's are two reads: a role lost between them still reaches routing.
    const sent = await sendWebConversationMessage({
      room: { id, externalId: String(room?.external_id), shape: room?.shape ?? 'direct' },
      projectId,
      userId: ownerId,
      content: 'Sent as the role went',
      mode: 'assistant',
      namedMode: false,
    });

    expect(sent.decision).toBe('unreachable');
    const windows = await harness.db.execute<{ decision: string; detail: { reason?: string } }>(
      sql`SELECT decision, decision_detail AS detail FROM conversation_windows WHERE conversation_id = ${id}`,
    );
    expect(windows.map((w) => w.decision)).toEqual(['unreachable']);
    expect(windows[0]?.detail.reason).toBe(
      'no agent of this project holds a role on it, so nothing here can answer',
    );
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`)).toBe(
      agentsBefore,
    );
  });

  it('still takes in a message where the agent holds its role', async () => {
    const opened = await as(ownerId, '/api/conversations', 'POST', { projectId });
    const { id } = (await opened.json()) as { id: string };
    const res = await as(ownerId, `/api/conversations/${id}/messages`, 'POST', {
      content: 'Hello',
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe('a viewer of the project', () => {
  const refusedFor = (refusal: Refusal) => {
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.message).toMatch(/member role/);
    expect(refusal.message).toMatch(/the role held is viewer/);
    expect(refusal.message).not.toMatch(/not a project member/i);
  };

  it('is refused opening a room there, naming the member role it needs and the viewer role it holds', async () => {
    const res = await as(viewerId, '/api/conversations', 'POST', { projectId });
    expect(res.status).toBe(403);
    refusedFor((await res.json()) as Refusal);
    expect(await count(sql`SELECT count(*)::int AS n FROM conversations`)).toBe(0);
  });

  it('is refused listing who could be added there, in the same words', async () => {
    const res = await as(viewerId, `/api/conversations/candidates?projectId=${projectId}`);
    expect(res.status).toBe(403);
    refusedFor((await res.json()) as Refusal);
  });
});
