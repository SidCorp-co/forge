/**
 * A person's comment on an issue is master work at any status: the box reads what the project's
 * threads owe through `GET /api/devices/me/comments/unanswered`, and a person posting wakes the
 * boxes serving the project with `source: "comment"`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import {
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';
import type { PoolBox } from '../helpers/pool-lanes-fixture.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let server: TestServer;
let box: PoolBox;
let personToken: string;
let agentId: string;
let publish: MockInstance;
let seq = 500;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  const { seedPoolBox } = await import('../helpers/pool-lanes-fixture.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { roomManager } = await import('../../src/ws/server.js');
  publish = vi.spyOn(roomManager, 'publish');
  box = await seedPoolBox(harness);
  personToken = await signUserToken(box.ownerId);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  agentId = agent.id;
  await createTestProjectMember(harness.db, {
    userId: agentId,
    projectId: box.projectId,
    role: 'member',
  });
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await server?.close();
  await harness?.cleanup();
});

beforeEach(() => publish.mockClear());

async function plantIssue(status: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${box.projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${box.ownerId})
  `);
  return id;
}

/** One comment at a fixed minute, so "after" is never decided by insertion order. */
async function plantComment(
  issueId: string,
  author: { userId: string; deviceId?: string },
  minute: number,
): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.UTC(2026, 9, 3, 9, minute)).toISOString();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, author_device_id, body, created_at, updated_at)
    VALUES (${id}, ${issueId}, ${author.userId}, ${author.deviceId ?? null}, 'planted', ${at}::timestamptz, ${at}::timestamptz)
  `);
  return id;
}

async function owed(token = box.deviceToken, projectId: string = box.projectId) {
  const res = await fetch(
    `${server.baseUrl}/api/devices/me/comments/unanswered?projectId=${projectId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: res.status, body: (await res.json()) as Doc };
}
const owedOn = async (issueId: string) =>
  (await owed()).body.items.filter((i: Doc) => i.issueId === issueId);

describe('what a thread owes a person', () => {
  it("a person's comment on an issue at developed is owed, naming the issue and the comment", async () => {
    const issue = await plantIssue('developed');
    const comment = await plantComment(issue, { userId: box.ownerId }, 1);
    const read = await owed();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(await owedOn(issue)).toEqual([
      expect.objectContaining({ issueId: issue, status: 'developed', commentId: comment }),
    ]);
  });

  it("an agent's reply after it clears it, from an agent account or from a box", async () => {
    for (const reply of [{ userId: agentId }, { userId: box.ownerId, deviceId: box.deviceId }]) {
      const issue = await plantIssue('awaiting_release');
      await plantComment(issue, { userId: box.ownerId }, 1);
      expect(await owedOn(issue)).toHaveLength(1);
      await plantComment(issue, reply, 2);
      expect(await owedOn(issue), JSON.stringify(reply)).toEqual([]);
    }
  });

  it('an agent reply BEFORE the person spoke clears nothing, and the newest person comment is named', async () => {
    const issue = await plantIssue('open');
    await plantComment(issue, { userId: agentId }, 1);
    await plantComment(issue, { userId: box.ownerId }, 2);
    const newest = await plantComment(issue, { userId: box.ownerId }, 3);
    expect(await owedOn(issue)).toEqual([expect.objectContaining({ commentId: newest })]);
  });

  it("an agent's own comment is never owed, whoever's account a box wrote it under", async () => {
    const issue = await plantIssue('developed');
    await plantComment(issue, { userId: agentId }, 1);
    await plantComment(issue, { userId: box.ownerId, deviceId: box.deviceId }, 2);
    expect(await owedOn(issue)).toEqual([]);
  });

  it('a closed or dropped issue owes nothing', async () => {
    for (const status of ['closed', 'dropped']) {
      const issue = await plantIssue(status);
      await plantComment(issue, { userId: box.ownerId }, 1);
      expect(await owedOn(issue), status).toEqual([]);
    }
  });

  it('refuses a missing projectId and a project the device is not bound to', async () => {
    const res = await fetch(`${server.baseUrl}/api/devices/me/comments/unanswered`, {
      headers: { authorization: `Bearer ${box.deviceToken}` },
    });
    expect(res.status).toBe(400);
    expect((await owed(box.deviceToken, randomUUID())).status).toBe(403);
  });
});

describe("a person's comment wakes the project's boxes", () => {
  const commentWakes = () =>
    publish.mock.calls
      .map((c) => c[1] as Doc)
      .filter((e) => e.event === 'master.wake' && e.data.source === 'comment')
      .map((e) => e.data);

  it('posting as a person wakes with source comment, and the comment is then owed', async () => {
    const issue = await plantIssue('awaiting_release');
    const res = await fetch(`${server.baseUrl}/api/issues/${issue}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${personToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'can this ship today?' }),
    });
    const posted = (await res.json()) as Doc;
    expect(res.status, JSON.stringify(posted)).toBe(201);
    expect(commentWakes()).toEqual([
      { projectId: box.projectId, source: 'comment', issueId: issue, commentId: posted.id },
    ]);
    expect(await owedOn(issue)).toEqual([expect.objectContaining({ commentId: posted.id })]);
  });
});
