/**
 * ISS-1372 — a comment is changed by the same people, and hung under the same parents, whichever
 * door it comes in by.
 *
 * REST `PATCH` and `DELETE /api/comments/:id` let the author and a project admin change a comment
 * and refuse everyone else; `forge_comments` update let any project writer rewrite another
 * person's comment. REST `POST /api/issues/:id/comments` refuses a reply whose parent sits on
 * another issue; the tool wrote it. This file drives both doors through the same cases, so a door
 * that admits what the other refuses goes red naming itself.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Caller,
  callRest,
  callTool,
  type Door,
  type Role,
  seedRoles,
} from '../helpers/door-parity.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let callers: Record<Role, Caller>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const seeded = await seedRoles(harness.db);
  projectId = seeded.projectId;
  ownerId = seeded.ownerId;
  callers = seeded.callers;
});

let seq = 0;
async function issue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${ownerId})`);
  return id;
}

async function comment(issueId: string, authorId: string, parentId: string | null = null) {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body, parent_id)
    VALUES (${id}, ${issueId}, ${authorId}, 'the first words', ${parentId})`);
  return id;
}

async function bodyOf(id: string): Promise<string | undefined> {
  const rows = (await harness.db.execute(
    sql`SELECT body FROM comments WHERE id = ${id}`,
  )) as unknown as Array<{ body: string }>;
  return rows[0]?.body;
}

async function commentCount(issueId: string): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

type Change = (who: Caller, commentId: string) => Promise<Door>;

const edits: Record<string, Change> = {
  'REST PATCH /api/comments/:id': (who, id) =>
    callRest(server.baseUrl, who.jwt, 'PATCH', `/api/comments/${id}`, { body: 'rewritten' }),
  'forge_comments update': (who, id) =>
    callTool(who.pat, 'forge_comments', {
      action: 'update',
      documentId: id,
      data: { body: 'rewritten' },
    }),
};

const deletes: Record<string, Change> = {
  'REST DELETE /api/comments/:id': (who, id) =>
    callRest(server.baseUrl, who.jwt, 'DELETE', `/api/comments/${id}`),
  'forge_comments delete': (who, id) =>
    callTool(who.pat, 'forge_comments', { action: 'delete', documentId: id }),
};

describe.each(Object.entries(edits))('an edit through %s', (_name, edit) => {
  it("refuses a member who is not the author, and leaves the author's words", async () => {
    const id = await comment(await issue(), callers.admin.userId);
    const { refused } = await edit(callers.member, id);
    expect(refused, "a member must not rewrite another person's comment").toBeDefined();
    expect(await bodyOf(id)).toBe('the first words');
  });

  it('admits the author', async () => {
    const id = await comment(await issue(), callers.member.userId);
    expect(await edit(callers.member, id)).not.toHaveProperty('refused');
    expect(await bodyOf(id)).toBe('rewritten');
  });

  it("admits a project admin on another person's comment", async () => {
    const id = await comment(await issue(), callers.member.userId);
    expect(await edit(callers.admin, id)).not.toHaveProperty('refused');
    expect(await bodyOf(id)).toBe('rewritten');
  });
});

describe.each(Object.entries(deletes))('a delete through %s', (_name, remove) => {
  it('refuses a member who is not the author, and keeps the comment', async () => {
    const id = await comment(await issue(), callers.admin.userId);
    const { refused } = await remove(callers.member, id);
    expect(refused).toBeDefined();
    expect(await bodyOf(id)).toBe('the first words');
  });

  it("admits a project admin on another person's comment", async () => {
    const id = await comment(await issue(), callers.member.userId);
    expect(await remove(callers.admin, id)).not.toHaveProperty('refused');
    expect(await bodyOf(id)).toBeUndefined();
  });
});

type Reply = (who: Caller, issueId: string, parentId: string) => Promise<Door>;

const replies: Record<string, Reply> = {
  'REST POST /api/issues/:id/comments': (who, issueId, parentId) =>
    callRest(server.baseUrl, who.jwt, 'POST', `/api/issues/${issueId}/comments`, {
      body: 'a reply',
      parentId,
    }),
  'forge_comments create': (who, issueId, parentId) =>
    callTool(who.pat, 'forge_comments', {
      action: 'create',
      data: { issue: issueId, body: 'a reply', parentId },
    }),
};

describe.each(Object.entries(replies))('a reply through %s', (_name, reply) => {
  it('refuses a parent that sits on another issue and writes no comment', async () => {
    const here = await issue();
    const parent = await comment(await issue(), callers.admin.userId);
    const { refused } = await reply(callers.member, here, parent);
    expect(refused, 'a reply must hang under a comment of its own issue').toBeDefined();
    expect(await commentCount(here)).toBe(0);
  });

  it('admits a parent on the same issue', async () => {
    const here = await issue();
    const parent = await comment(here, callers.admin.userId);
    expect(await reply(callers.member, here, parent)).not.toHaveProperty('refused');
    expect(await commentCount(here)).toBe(2);
  });
});
