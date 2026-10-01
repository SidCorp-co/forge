import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let store: typeof import('../../src/conversations/store.js');
let participants: typeof import('../../src/conversations/participants.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  store = await import('../../src/conversations/store.js');
  participants = await import('../../src/conversations/participants.js');
  app = new Hono();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let projectId: string;
let slug: string;
const person = {} as Record<'me' | 'colleague' | 'outsider' | 'stranger', string>;

async function verifiedUser(): Promise<string> {
  const u = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${u.id}`);
  return u.id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  person.me = await verifiedUser();
  const project = await createTestProject(harness.db, person.me);
  projectId = project.id;
  slug = project.slug;
  for (const who of ['colleague', 'outsider'] as const) {
    person[who] = await verifiedUser();
    await createTestProjectMember(harness.db, { userId: person[who], projectId, role: 'member' });
  }
  person.stranger = await verifiedUser();
});

async function room(shape: 'direct' | 'group', people: string[]): Promise<string> {
  const opened = await store.openConversation({
    adapter: 'web',
    externalId: `web ${randomUUID()}`,
    shape,
    projectId,
  });
  for (const userId of people) await participants.addPerson({ conversationId: opened.id, userId });
  return opened.id;
}

async function audit(conversationId: string, calls: Record<string, unknown>[]) {
  await harness.db.execute(sql`
    INSERT INTO chat_logs (session_id, project_slug, query, tool_calls)
    VALUES (${conversationId}, ${slug}, 'q', ${JSON.stringify(calls)}::jsonb)`);
}

const call = (ranAs: string | null) => ({
  name: 'forge_issues',
  arguments: '{"action":"get"}',
  round: 1,
  isError: false,
  durationMs: 4,
  resultPreview: `read as ${ranAs}`,
  resultIssueRefs: ['ISS-1'],
  ranAs,
  refusalCode: null,
});

type Call = Record<string, unknown>;
type ReadBody = { code?: string; calls?: Call[] };

async function read(as: string, conversationId: string) {
  const res = await app.request(`http://localhost/api/conversations/${conversationId}/tool-calls`, {
    headers: { authorization: `Bearer ${await signUserToken(as)}` },
  });
  return { status: res.status, body: (await res.json()) as ReadBody };
}

describe('who may read a room’s tool calls', () => {
  it('refuses a person with no role on the room’s project, by name', async () => {
    const id = await room('group', [person.me]);
    await audit(id, [call(person.me)]);
    const got = await read(person.stranger, id);
    expect(got.status).toBe(403);
    expect(got.body.code).toBe('CONVERSATION_OUT_OF_SCOPE');
    expect(got.body.calls).toBeUndefined();
  });

  it('refuses a project member who is not one of a one-to-one room’s people', async () => {
    const id = await room('direct', [person.me]);
    await audit(id, [call(person.me)]);
    const got = await read(person.outsider, id);
    expect(got.status).toBe(403);
    expect(got.body.code).toBe('NOT_IN_THE_ROOM');
  });
});

describe('whose results a reader is shown', () => {
  it('shows a reader the result of a call run as them, and hides another member’s, naming both', async () => {
    const id = await room('group', [person.me, person.colleague]);
    await audit(id, [call(person.me), call(person.colleague), call(null)]);
    const got = await read(person.me, id);
    expect(got.status).toBe(200);
    expect((got.body.calls ?? []).map((c) => [c.ranAs, c.ranAsRecorded, c.resultPreview])).toEqual([
      [person.me, true, `read as ${person.me}`],
      [person.colleague, true, null],
      [null, true, 'read as null'],
    ]);
  });

  it('reads a call audited before ranAs was recorded as unrecorded, with its result hidden', async () => {
    const id = await room('group', [person.me]);
    const { ranAs: _r, ...old } = call(person.me);
    await audit(id, [old]);
    const [c] = (await read(person.me, id)).body.calls ?? [];
    expect(c).toMatchObject({ ranAsRecorded: false, ranAs: null, resultPreview: null });
  });
});
