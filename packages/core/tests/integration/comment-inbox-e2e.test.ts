/**
 * A person's question on an issue is master work at any status: the box reads what the project's
 * threads owe through `GET /api/devices/me/comments/unanswered`, and a person posting wakes the
 * boxes serving the project with `source: "comment"`. Only an agent's REPLY to the question clears
 * it (`devices/comment-inbox.ts:readOwedComments`); another agent comment on the issue does not.
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
  publish = vi.spyOn(roomManager, 'publish').mockImplementation(() => 0);
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
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at)
    VALUES (${id}, ${box.projectId}, ${seq}, ${`planted ${status}`}, ${status}, ${box.ownerId},
            ${status === 'closed' ? sql`now()` : sql`NULL`})
  `);
  return id;
}

type Author = { userId: string; deviceId?: string };

/** One comment at a fixed minute, so "after" is never decided by insertion order. */
async function plantComment(
  issueId: string,
  author: Author,
  minute: number,
  opts: { intent?: 'question' | 'decision' | 'note'; parentId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.UTC(2026, 9, 3, 9, minute)).toISOString();
  const intent = opts.intent ?? 'question';
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, author_device_id, body, intent, parent_id,
                          created_at, updated_at)
    VALUES (${id}, ${issueId}, ${author.userId}, ${author.deviceId ?? null}, 'planted', ${intent},
            ${opts.parentId ?? null}, ${at}::timestamptz, ${at}::timestamptz)
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
  it("a person's question on an issue in progress is owed, naming the issue and the comment", async () => {
    const issue = await plantIssue('in_progress');
    const comment = await plantComment(issue, { userId: box.ownerId }, 1);
    const read = await owed();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(await owedOn(issue)).toEqual([
      expect.objectContaining({ issueId: issue, status: 'in_progress', commentId: comment }),
    ]);
  });

  it("a person's note or decision is owed nothing", async () => {
    for (const intent of ['note', 'decision'] as const) {
      const issue = await plantIssue('in_progress');
      await plantComment(issue, { userId: box.ownerId }, 1, { intent });
      expect(await owedOn(issue), intent).toEqual([]);
    }
  });

  it("an agent's threaded reply clears it, from an agent account or from a box", async () => {
    for (const reply of [{ userId: agentId }, { userId: box.ownerId, deviceId: box.deviceId }]) {
      const issue = await plantIssue('awaiting_release');
      const question = await plantComment(issue, { userId: box.ownerId }, 1);
      expect(await owedOn(issue)).toHaveLength(1);
      await plantComment(issue, reply, 2, { intent: 'note', parentId: question });
      expect(await owedOn(issue), JSON.stringify(reply)).toEqual([]);
    }
  });

  // D7 of the 2026-10-04 e2e run: any newer agent comment, even an unrelated note, cleared it.
  it('a newer agent comment that is not a reply to the question clears nothing', async () => {
    for (const intent of ['note', 'decision', 'question'] as const) {
      const issue = await plantIssue('in_progress');
      const question = await plantComment(issue, { userId: box.ownerId }, 1);
      await plantComment(issue, { userId: agentId }, 2, { intent });
      await plantComment(issue, { userId: box.ownerId, deviceId: box.deviceId }, 3, { intent });
      expect(await owedOn(issue), intent).toEqual([
        expect.objectContaining({ commentId: question }),
      ]);
    }
  });

  it('a question asked inside a thread is cleared by a later agent reply in that thread', async () => {
    const issue = await plantIssue('in_progress');
    const root = await plantComment(issue, { userId: agentId }, 1, { intent: 'note' });
    const question = await plantComment(issue, { userId: box.ownerId }, 2, { parentId: root });
    await plantComment(issue, { userId: agentId }, 3, { intent: 'note', parentId: root });
    expect(await owedOn(issue)).toEqual([]);
    const later = await plantComment(issue, { userId: box.ownerId }, 4, { parentId: root });
    expect(await owedOn(issue)).toEqual([expect.objectContaining({ commentId: later })]);
    expect(question).not.toBe(later);
  });

  it('a reply to an earlier question clears only that one, and the newest open question is named', async () => {
    const issue = await plantIssue('open');
    const first = await plantComment(issue, { userId: box.ownerId }, 1);
    await plantComment(issue, { userId: agentId }, 2, { intent: 'note', parentId: first });
    const newest = await plantComment(issue, { userId: box.ownerId }, 3);
    expect(await owedOn(issue)).toEqual([expect.objectContaining({ commentId: newest })]);
  });

  it("an agent's own comment is never owed, whoever's account a box wrote it under", async () => {
    const issue = await plantIssue('in_progress');
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

  it('posting a question as a person wakes with source comment, and the question is then owed', async () => {
    const issue = await plantIssue('awaiting_release');
    const res = await fetch(`${server.baseUrl}/api/issues/${issue}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${personToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'can this ship today?', intent: 'question' }),
    });
    const posted = (await res.json()) as Doc;
    expect(res.status, JSON.stringify(posted)).toBe(201);
    // The wake is published after the write's response (`ws/master-wake.ts`), so it is awaited.
    await vi.waitFor(() =>
      expect(commentWakes()).toEqual([
        { projectId: box.projectId, source: 'comment', issueId: issue, commentId: posted.id },
      ]),
    );
    expect(await owedOn(issue)).toEqual([expect.objectContaining({ commentId: posted.id })]);
  });
});
