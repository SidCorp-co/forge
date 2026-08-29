/**
 * An agent-filed `draft` has to reach a human — against real Postgres.
 *
 * This is the ONLY runtime that can fail on this bucket's predicate.
 * `me/attention-routes.test.ts` mocks `db.select()` into a chain that ignores
 * every `where` and resolves positionally, so there it maps rows it was handed
 * and cannot disagree about which rows those should be. The four narrowings
 * ARE the deliverable: agent channel, owned-for-answer, no human comment, and
 * a cap whose total still tells the truth.
 *
 * Measured on forge-dev 2026-08-29, the state that produced ISS-881: 25 drafts,
 * 22 of them `created_via='mcp'`, all 22 with `assignee_id` NULL, all 22 with
 * zero human comments — and no surface anywhere listed one of them. ISS-871
 * ("half of all forge-drive sessions fail") was the 11th-newest of the 22.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestOrgMember,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';

// cm:guard ONE harness for the whole file. `db/client.ts` binds to DATABASE_URL at import time, so a second setupTestDatabase() puts the fixtures on one database and everything the code under test writes on another — the tests then read empty tables and fail for a reason that has nothing to do with the code.
let harness: TestDatabase;
let ownerId: string;
let otherId: string;
let projectId: string;
let deviceId: string;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let authHeader: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { meAttentionRoutes } = await import('../../src/me/attention-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{
    Variables: import('../../src/middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/me', meAttentionRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  otherId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  const org = await seedOrg(harness.db, ownerId);
  await createTestOrgMember(harness.db, { orgId: org.id, userId: otherId });
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  deviceId = (await createTestDevice(harness.db, ownerId)).id;

  const { signUserToken } = await import('../../src/auth/jwt.js');
  authHeader = `Bearer ${await signUserToken(ownerId)}`;
});

interface Item {
  kind: string;
  issueRef: string;
  status: string;
}

interface Body {
  unseenDrafts: Item[];
  unseenDraftsTotal: number;
  awaitingInput: Item[];
  total: number;
}

async function attention(): Promise<Body> {
  const res = await app.request('/api/me/attention', {
    headers: { authorization: authHeader },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

async function draft(
  opts: { status?: string; via?: string | null; createdBy?: string; assignee?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_via, created_by_id, assignee_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${opts.status ?? 'draft'},
            ${opts.via === undefined ? 'mcp' : opts.via}, ${opts.createdBy ?? ownerId},
            ${opts.assignee ?? null})
  `);
  return id;
}

async function comment(
  issueId: string,
  opts: { isAi: boolean; device?: boolean; author?: string },
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, author_device_id, is_ai, body)
    VALUES (${randomUUID()}, ${issueId}, ${opts.author ?? ownerId},
            ${opts.device ? deviceId : null}, ${opts.isAi}, 'body')
  `);
}

async function statusOf(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`SELECT status FROM issues WHERE id = ${issueId}`);
  return (rows[0] as { status: string }).status;
}

describe('attention · unseen agent-filed drafts', () => {
  it('surfaces a draft an agent filed on an issue nobody owns', async () => {
    await draft();
    const body = await attention();
    expect(body.unseenDrafts).toHaveLength(1);
    expect(body.unseenDrafts[0]?.kind).toBe('unseen_draft');
    expect(body.unseenDrafts[0]?.status).toBe('draft');
    expect(body.unseenDraftsTotal).toBe(1);
    expect(body.total).toBe(1);
  });

  // cm:why the whole point of the bucket: `draft` is not a park, so it must NOT arrive as one. Folding it into awaitingInput would make the parks bucket claim a human was asked a question nobody asked.
  it('does not put it in the awaiting-input parks bucket', async () => {
    await draft();
    expect((await attention()).awaitingInput).toHaveLength(0);
  });

  it('surfaces a draft explicitly assigned to the caller, whoever filed it', async () => {
    await draft({ createdBy: otherId, assignee: ownerId });
    expect((await attention()).unseenDrafts).toHaveLength(1);
  });

  it('does not surface a draft assigned to someone else', async () => {
    await draft({ createdBy: ownerId, assignee: otherId });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('does not surface an unowned draft the caller did not file', async () => {
    await draft({ createdBy: otherId, assignee: null });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('ignores a draft a person typed on the web — they have already seen it', async () => {
    await draft({ via: 'web' });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  // cm:why legacy rows predate `created_via` and read as human backlog, matching buildOriginCondition in issues/creator.ts. Reading NULL as agent-filed would dump every pre-column draft into one inbox at once.
  it('ignores a legacy draft with no recorded channel', async () => {
    await draft({ via: null });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('carries the other agent channels through the same predicate', async () => {
    await draft({ via: 'pipeline' });
    await draft({ via: 'schedule' });
    await draft({ via: 'system' });
    expect((await attention()).unseenDrafts).toHaveLength(3);
  });

  it('drops it once a human comments, and leaves the issue at draft', async () => {
    const id = await draft();
    await comment(id, { isAi: false });
    expect((await attention()).unseenDrafts).toHaveLength(0);
    expect(await statusOf(id)).toBe('draft');
  });

  // cm:guard an agent MUST NOT be able to acknowledge for a human. Both halves of the marker have to be checked: a device-authored comment carries the owner's user id in author_id, so testing is_ai alone lets a PAT-lane agent comment clear the bucket.
  it('is not cleared by an agent comment', async () => {
    const flagged = await draft();
    await comment(flagged, { isAi: true });
    const byDevice = await draft();
    await comment(byDevice, { isAi: false, device: true });
    expect((await attention()).unseenDrafts).toHaveLength(2);
  });

  // cm:why the receipt means A PERSON saw it, not that the owner replied. A teammate reading the draft and answering in the thread is exactly the routing this bucket exists to produce.
  it("is cleared by any human comment, not only the owner's", async () => {
    const id = await draft();
    await comment(id, { isAi: false, author: otherId });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('leaves the bucket when the draft leaves draft, with no bookkeeping', async () => {
    const id = await draft();
    await harness.db.execute(sql`UPDATE issues SET status = 'open' WHERE id = ${id}`);
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  // cm:guard the cap bounds the SCREEN, never the truth. A total computed from the capped list instead of the predicate is how a 22-deep backlog renders as "20" and stops being a backlog anyone chases.
  it('caps the list at 20 and still reports the full count', async () => {
    for (let i = 0; i < 22; i += 1) await draft();
    const body = await attention();
    expect(body.unseenDrafts).toHaveLength(20);
    expect(body.unseenDraftsTotal).toBe(22);
    expect(body.total).toBe(20);
  });
});
