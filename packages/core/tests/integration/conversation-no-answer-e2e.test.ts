/**
 * ISS-1229 r35 — judge-95 sent the first message in a room whose only agent had lost its role on the
 * project: core stored the message, then answered 500, and nothing ever answered it. Routing the window
 * minted a second agent for the project, outside any transaction, and the mint collided on the handle
 * the first one still holds. The message is now kept and answered 201, its window closed unreachable
 * for that cause; a mint that would collide is refused by name wherever it is reached.
 *
 * The same judge, a viewer of the project, was invited to open a room there and refused "Not a project
 * member." — which the viewer is. Both doors now say the viewer role and that a viewer cannot start one.
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

const agents = () => count(sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`);

const LOST_ROLE =
  '@ledger, the agent of Ledger, no longer holds a role on Ledger, so it cannot answer there; give it a role on Ledger again first.';

describe('a room no agent can answer', () => {
  it('keeps a message sent there, answers 201, and closes its window unreachable for that cause', async () => {
    const { id } = await roomNobodyAnswers();
    const before = await agents();

    const res = await as(ownerId, `/api/conversations/${id}/messages`, 'POST', {
      content: 'Hello, which issues are open in this project?',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json()) as { decision: string }).toMatchObject({ decision: 'unreachable' });

    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${id}`,
      ),
    ).toBe(1);
    const windows = await harness.db.execute<{
      decision: string;
      detail: { reason?: string; cause?: string };
    }>(
      sql`SELECT decision, decision_detail AS detail FROM conversation_windows WHERE conversation_id = ${id}`,
    );
    expect(windows.map((w) => [w.decision, w.detail.cause])).toEqual([
      ['unreachable', 'agent-lost-role'],
    ]);
    expect(windows[0]?.detail.reason).toBe(
      'no agent of this project holds a role on it, so nothing here can answer',
    );
    expect(await agents()).toBe(before);

    const again = await as(ownerId, `/api/conversations/${id}/messages`, 'POST', {
      content: 'Anyone?',
    });
    expect(again.status, await again.clone().text()).toBe(201);
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

describe('a project whose agent lost its role', () => {
  it('refuses opening a room on it by name, opening nothing and minting no second agent', async () => {
    await roomNobodyAnswers();
    const before = await agents();
    const rooms = await count(sql`SELECT count(*)::int AS n FROM conversations`);

    const res = await as(ownerId, '/api/conversations', 'POST', { projectId });
    const refusal = (await res.json()) as Refusal;
    expect([res.status, refusal.code, refusal.message]).toEqual([
      409,
      'PROJECT_AGENT_LOST_ROLE',
      LOST_ROLE,
    ]);
    expect(await count(sql`SELECT count(*)::int AS n FROM conversations`)).toBe(rooms);
    expect(await agents()).toBe(before);
  });

  it('refuses adding its agent to another room by the project alone, by name', async () => {
    const { agentId } = await roomNobodyAnswers();
    const desk = (
      await createTestProject(harness.db, ownerId, {
        slug: 'desk',
        name: 'Desk',
        orgId: String(
          (
            await harness.db.execute<{ org_id: string }>(
              sql`SELECT org_id FROM projects WHERE id = ${projectId}`,
            )
          )[0]?.org_id,
        ),
      })
    ).id;
    const opened = await as(ownerId, '/api/conversations', 'POST', { projectId: desk });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const { id } = (await opened.json()) as { id: string };

    const offered = await as(ownerId, `/api/conversations/${id}/candidates`);
    expect(offered.status, await offered.clone().text()).toBe(200);
    const { handles } = (await offered.json()) as {
      handles: Array<{ userId: string | null; handle: string; reachable: boolean }>;
    };
    expect(handles.find((h) => h.handle === 'ledger')).toMatchObject({
      userId: agentId,
      reachable: false,
    });

    const res = await as(ownerId, `/api/conversations/${id}/handles`, 'POST', { projectId });
    const refusal = (await res.json()) as Refusal;
    expect([res.status, refusal.code, refusal.message]).toEqual([
      409,
      'PROJECT_AGENT_LOST_ROLE',
      LOST_ROLE,
    ]);
  });
});

describe('a viewer of the project', () => {
  const refusedFor = (refusal: Refusal) => {
    expect(refusal.code).toBe('FORBIDDEN');
    expect(refusal.message).toBe(
      'You hold the viewer role on Ledger; a viewer cannot start a room.',
    );
  };

  it('is refused opening a room there, told the viewer role it holds and that a viewer cannot start one', async () => {
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

/**
 * ISS-1229 r36, judge-97: Start a conversation offered Ledger, whose own agent had lost its role there,
 * unmarked; it was picked and confirmed, and only opening the room was refused. Whose agent can answer
 * is now read before anything is picked.
 */
describe('the projects a room may be opened on', () => {
  type Opener = { projectId: string; handle: string; reachable: boolean };
  const openers = async (userId: string): Promise<Opener[]> => {
    const res = await as(userId, '/api/conversations/openers');
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { openers: Opener[] }).openers;
  };

  it('answers each project the caller may open a room on with its agent, which answers until it loses its role', async () => {
    expect(await openers(ownerId)).toEqual([{ projectId, handle: 'ledger', reachable: true }]);
    await roomNobodyAnswers();
    expect(await openers(ownerId)).toEqual([{ projectId, handle: 'ledger', reachable: false }]);
  });

  it('leaves out a project the caller only views, and one archived', async () => {
    expect(await openers(viewerId)).toEqual([]);
    await harness.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}`);
    expect(await openers(ownerId)).toEqual([]);
  });
});

/**
 * ISS-1229 r36, judge-97: a viewer's rename in a room they can open was refused saying the room is
 * "reached only by someone who holds" a member role, which the viewer had just reached.
 */
describe('a write by a viewer of the room', () => {
  const VIEWER_WRITE =
    'You hold the viewer role on Ledger; a viewer can read this room but not change it or post in it.';

  async function groupRoom(): Promise<string> {
    const opened = await as(ownerId, '/api/conversations', 'POST', {
      projectId,
      people: [viewerId],
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    return ((await opened.json()) as { id: string }).id;
  }

  it('reads the room, and renaming, archiving, deleting or posting there is refused naming the viewer role', async () => {
    const id = await groupRoom();
    expect((await as(viewerId, `/api/conversations/${id}`)).status).toBe(200);
    const writes: Array<[string, string, unknown]> = [
      [`/api/conversations/${id}`, 'PATCH', { title: 'Renamed by a viewer' }],
      [`/api/conversations/${id}`, 'PATCH', { archived: true }],
      [`/api/conversations/${id}`, 'DELETE', undefined],
      [`/api/conversations/${id}/messages`, 'POST', { content: 'May I?' }],
    ];
    for (const [path, method, body] of writes) {
      const res = await as(viewerId, path, method, body);
      const refusal = (await res.json()) as Refusal;
      expect([method, res.status, refusal.code, refusal.message]).toEqual([
        method,
        403,
        'CONVERSATION_OUT_OF_SCOPE',
        VIEWER_WRITE,
      ]);
    }
    const [row] = await harness.db.execute<{ title: string | null; archived_at: Date | null }>(
      sql`SELECT title, archived_at FROM conversations WHERE id = ${id}`,
    );
    expect(row).toMatchObject({ title: null, archived_at: null });
  });

  it('tells somebody holding no role there that they do not reach the room at all', async () => {
    const id = await groupRoom();
    const stranger = await verifiedUser();
    const res = await as(stranger, `/api/conversations/${id}`, 'PATCH', { title: 'x' });
    const refusal = (await res.json()) as Refusal;
    expect([res.status, refusal.code, refusal.message]).toEqual([
      403,
      'CONVERSATION_OUT_OF_SCOPE',
      'This room is about Ledger, on which you hold no role; a room is reached only by someone who holds one on every project in it.',
    ]);
  });
});

/**
 * ISS-1229 r36, judge-97: a reply the reply check withdrew was said only by a socket frame, so a reload,
 * or a person opening the room later, never learned of it. The draft is stored with the reply.
 */
describe('a reply the reply check withdrew', () => {
  it('is read back with the room, its draft beside the reply that replaced it, for anyone who opens it later', async () => {
    const opened = await as(ownerId, '/api/conversations', 'POST', {
      projectId,
      people: [viewerId],
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const { id } = (await opened.json()) as { id: string };
    const { recordDeliveredReply } = await import('../../src/conversations/transcript.js');
    await recordDeliveredReply({
      conversationId: id,
      projectId,
      text: 'I could not verify that claim.',
      receipt: { messageId: null },
      deliveryKey: 'k-withdrawn',
      withdrawnDraft: 'ISS-4242 was closed yesterday and shipped in v9.2.',
    });
    await recordDeliveredReply({
      conversationId: id,
      projectId,
      text: 'Two issues are open.',
      receipt: { messageId: null },
      deliveryKey: 'k-plain',
    });

    for (const reader of [ownerId, viewerId]) {
      const res = await as(reader, `/api/conversations/${id}`);
      expect(res.status, await res.clone().text()).toBe(200);
      const { messages } = (await res.json()) as {
        messages: Array<{ content: string; withdrawnDraft: string | null }>;
      };
      expect(messages.map((m) => [m.content, m.withdrawnDraft])).toEqual([
        ['I could not verify that claim.', 'ISS-4242 was closed yesterday and shipped in v9.2.'],
        ['Two issues are open.', null],
      ]);
    }
  });
});
