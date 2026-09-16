/**
 * An agent-filed `draft` has to reach a human — against real Postgres.
 *
 * This is the ONLY runtime that can fail on this bucket's predicate.
 * `me/attention-routes.test.ts` mocks `db.select()` into a chain that ignores
 * every `where` and resolves positionally, so there it maps rows it was handed
 * and cannot disagree about which rows those should be. Four narrowings ARE the
 * deliverable: agent channel, owner rule, no human comment, priority order
 * under a cap whose total still tells the truth.
 *
 * The routing half is what live data falsified first (forge-beta, 2026-08-30):
 * MCP stamps `createdById: device.ownerId`, so creator-only returned 428
 * qualifying drafts over 16 projects to the paired account nobody signs into
 * and 0 to the org admin who does. ISS-871 sits at rank 17 of those 428 under
 * priority-then-recency, and rank 28 under plain recency.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';

let harness: TestDatabase;
let ownerId: string;
let otherId: string;
let projectId: string;
let deviceId: string;
let projectAdminId: string;
let orgAdminId: string;
let plainMemberId: string;
let viewerId: string;
let foreignOrgAdminId: string;
let foreignProjectAdminId: string;
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

  projectAdminId = (await createTestUser(harness.db)).id;
  orgAdminId = (await createTestUser(harness.db)).id;
  plainMemberId = (await createTestUser(harness.db)).id;
  viewerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  await createTestOrgMember(harness.db, { orgId: org.id, userId: projectAdminId });
  await createTestOrgMember(harness.db, { orgId: org.id, userId: plainMemberId });
  await createTestOrgMember(harness.db, { orgId: org.id, userId: viewerId });
  await createTestOrgMember(harness.db, { orgId: org.id, userId: orgAdminId, role: 'admin' });
  await createTestProjectMember(harness.db, {
    projectId,
    userId: projectAdminId,
    role: 'admin',
  });
  await createTestProjectMember(harness.db, {
    projectId,
    userId: plainMemberId,
    role: 'member',
  });
  await createTestProjectMember(harness.db, { projectId, userId: viewerId, role: 'viewer' });

  foreignOrgAdminId = (await createTestUser(harness.db)).id;
  foreignProjectAdminId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  const foreignOrg = await seedOrg(harness.db, foreignOrgAdminId);
  const foreignProject = await createTestProject(harness.db, foreignOrgAdminId, {
    orgId: foreignOrg.id,
  });
  await createTestOrgMember(harness.db, { orgId: foreignOrg.id, userId: foreignProjectAdminId });
  await createTestProjectMember(harness.db, {
    projectId: foreignProject.id,
    userId: foreignProjectAdminId,
    role: 'admin',
  });

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

async function attentionAs(userId: string): Promise<Body> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const res = await app.request('/api/me/attention', {
    headers: { authorization: `Bearer ${await signUserToken(userId)}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

async function draft(
  opts: {
    status?: string;
    via?: string | null;
    createdBy?: string;
    assignee?: string | null;
    priority?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_via, created_by_id, assignee_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${opts.status ?? 'draft'},
            ${opts.priority ?? 'medium'}, ${opts.via === undefined ? 'mcp' : opts.via},
            ${opts.createdBy ?? ownerId}, ${opts.assignee ?? null})
  `);
  return id;
}

async function comment(
  issueId: string,
  opts: { device?: boolean; author?: string } = {},
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, author_device_id, body)
    VALUES (${randomUUID()}, ${issueId}, ${opts.author ?? ownerId},
            ${opts.device ? deviceId : null}, 'body')
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

  it('surfaces an unowned draft the caller did not file, when the caller administers the project', async () => {
    await draft({ createdBy: otherId, assignee: null });
    expect((await attention()).unseenDrafts).toHaveLength(1);
  });

  it('reaches an explicit project admin who neither filed it nor owns it', async () => {
    await draft({ createdBy: otherId, assignee: null });
    expect((await attentionAs(projectAdminId)).unseenDrafts).toHaveLength(1);
  });

  it('reaches an org admin, which is how the real deployment routes', async () => {
    await draft({ createdBy: otherId, assignee: null });
    expect((await attentionAs(orgAdminId)).unseenDrafts).toHaveLength(1);
  });

  it('does not reach a project member at role member', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(plainMemberId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  it('does not reach a project member at role viewer', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(viewerId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  it('does not reach an admin of a different org', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(foreignOrgAdminId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  it('does not reach a project admin of a different project', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(foreignProjectAdminId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  it('reaches the creator even when they administer nothing', async () => {
    await draft({ createdBy: plainMemberId, assignee: null });
    expect((await attentionAs(plainMemberId)).unseenDrafts).toHaveLength(1);
  });

  it('does not reach the project admin once someone is assigned', async () => {
    await draft({ createdBy: otherId, assignee: otherId });
    expect((await attentionAs(projectAdminId)).unseenDrafts).toHaveLength(0);
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('ignores a draft a person typed on the web — they have already seen it', async () => {
    await draft({ via: 'web' });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

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
    await comment(id);
    expect((await attention()).unseenDrafts).toHaveLength(0);
    expect(await statusOf(id)).toBe('draft');
  });

  it('is not cleared by a device comment', async () => {
    const id = await draft();
    await comment(id, { device: true });
    expect((await attention()).unseenDrafts).toHaveLength(1);
  });

  it('IS cleared by an agent holding a human credential, as that human', async () => {
    const id = await draft();
    await comment(id);
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it("is cleared by any human comment, not only the owner's", async () => {
    const id = await draft();
    await comment(id, { author: otherId });
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('leaves the bucket when the draft leaves draft, with no bookkeeping', async () => {
    const id = await draft();
    await harness.db.execute(sql`UPDATE issues SET status = 'open' WHERE id = ${id}`);
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  it('orders by priority before recency', async () => {
    await draft({ priority: 'low' });
    await draft({ priority: 'critical' });
    await draft({ priority: 'medium' });
    const rows = (await attention()).unseenDrafts;
    expect(rows.map((r) => r.issueRef)).toHaveLength(3);
    const seqs = rows.map((r) => r.issueRef);
    expect(seqs[0]).toBe(`ISS-${seq - 1}`);
  });

  it('counts only what the predicate matches, not every draft', async () => {
    await draft();
    const seen = await draft();
    await comment(seen);
    await draft({ via: 'web' });
    await draft({ createdBy: otherId, assignee: otherId });
    await draft({ status: 'open' });
    const body = await attention();
    expect(body.unseenDrafts).toHaveLength(1);
    expect(body.unseenDraftsTotal).toBe(1);
  });

  it('caps the list at 20 and still reports the full count', async () => {
    for (let i = 0; i < 22; i += 1) await draft();
    const body = await attention();
    expect(body.unseenDrafts).toHaveLength(20);
    expect(body.unseenDraftsTotal).toBe(22);
    expect(body.total).toBe(20);
  });
});
