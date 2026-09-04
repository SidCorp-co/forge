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

// cm:guard ONE harness for the whole file. `db/client.ts` binds to DATABASE_URL at import time, so a second setupTestDatabase() puts the fixtures on one database and everything the code under test writes on another — the tests then read empty tables and fail for a reason that has nothing to do with the code.
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
  // cm:guard these two MUST hold real `project_members` rows, or the negative cases below only re-prove what authz.ts already guarantees: measured 2026-08-30, with them absent, deleting `role = 'admin'` from adminsProject left 18 of 18 cases passing.
  await createTestProjectMember(harness.db, {
    projectId,
    userId: plainMemberId,
    role: 'member',
  });
  await createTestProjectMember(harness.db, { projectId, userId: viewerId, role: 'viewer' });

  // cm:guard a SECOND org holding a SECOND project, with an admin on each side of it. Both correlation clauses in adminsProject (`project_members.project_id = projects.id`, `organization_members.org_id = projects.org_id`) are invisible to a single-project single-org fixture: measured 2026-08-30, deleting either left 591 of 591 integration cases green while every project of every org became readable to anyone holding one admin row anywhere.
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

  // cm:why this case INVERTED with the routing fix and that is the point: `ownerId` administers the project, and an unowned agent proposal is a triage item for whoever administers it — not only for whichever account happened to be holding the runner's credential.
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

  // cm:guard membership alone must NOT admit anyone, and this is a TENANT boundary, not a preference: the same `adminsProject` predicate gates `pendingSkillUpdates`, so a one-line widening here hands every agent-filed draft AND every skill-update gate to every member of the project.
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

  // cm:guard `organization_members.org_id = projects.org_id`. An org owner is admin over THEIR org's projects and nothing else; without the correlation the clause reads "is an admin of any org at all", and one tenant's proposals land in another tenant's inbox.
  it('does not reach an admin of a different org', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(foreignOrgAdminId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  // cm:guard `project_members.project_id = projects.id`. Same failure one level down: a project admin somewhere must not be a project admin everywhere.
  it('does not reach a project admin of a different project', async () => {
    await draft({ createdBy: otherId, assignee: null });
    const body = await attentionAs(foreignProjectAdminId);
    expect(body.unseenDrafts).toHaveLength(0);
    expect(body.unseenDraftsTotal).toBe(0);
  });

  // cm:guard the creator half of the owner rule, tested on someone who is NOT also an admin — `ownerId` is the org owner, so every case using it passes on the admin clause alone and says nothing about this one. A member who files a proposal with their own credential must keep seeing it.
  it('reaches the creator even when they administer nothing', async () => {
    await draft({ createdBy: plainMemberId, assignee: null });
    expect((await attentionAs(plainMemberId)).unseenDrafts).toHaveLength(1);
  });

  // cm:guard assignment wins over BOTH fallbacks. An assigned proposal in the project admin's list as well means two people each assume the other triaged it.
  it('does not reach the project admin once someone is assigned', async () => {
    await draft({ createdBy: otherId, assignee: otherId });
    expect((await attentionAs(projectAdminId)).unseenDrafts).toHaveLength(0);
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
    await comment(id);
    expect((await attention()).unseenDrafts).toHaveLength(0);
    expect(await statusOf(id)).toBe('draft');
  });

  // cm:guard a DEVICE comment must never acknowledge for a human — a device-authored comment carries the owner's user id in author_id, so `author_id` alone is not the test and `author_device_id IS NULL` is.
  it('is not cleared by a device comment', async () => {
    const id = await draft();
    await comment(id, { device: true });
    expect((await attention()).unseenDrafts).toHaveLength(1);
  });

  // cm:guard this is the PRICE of dropping `comments.is_ai` (2026-09-04), asserted so it is a decision on the record and not a silent regression: an agent holding a person's PAT clears this bucket AS that person, because identity follows the token and a PAT-lane comment is indistinguishable from one the person typed. The fix is agent identity, not a self-declared flag — until then the receipt means "something on a human credential replied", not "a human read it".
  it('IS cleared by an agent holding a human credential, as that human', async () => {
    const id = await draft();
    await comment(id);
    expect((await attention()).unseenDrafts).toHaveLength(0);
  });

  // cm:why the receipt means A PERSON saw it, not that the owner replied. A teammate reading the draft and answering in the thread is exactly the routing this bucket exists to produce.
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

  // cm:guard priority outranks recency here, or a fleet-deep backlog hands all 20 rows to whichever project wrote last. Measured: under plain recency ISS-871 sat at rank 28 of 428 and this bucket could not show its own reason for existing.
  it('orders by priority before recency', async () => {
    await draft({ priority: 'low' });
    await draft({ priority: 'critical' });
    await draft({ priority: 'medium' });
    const rows = (await attention()).unseenDrafts;
    expect(rows.map((r) => r.issueRef)).toHaveLength(3);
    const seqs = rows.map((r) => r.issueRef);
    expect(seqs[0]).toBe(`ISS-${seq - 1}`);
  });

  // cm:guard the count must be measured through the SAME predicate as the list. Only the cap half of that guard is covered by the case below: if the count were wider, a total of 3 over a list of 1 would go unnoticed, which is the surface lying in the same breath it was added to stop a surface from lying.
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

  // cm:guard the cap bounds the SCREEN, never the truth. A total computed from the capped list instead of the predicate is how a 22-deep backlog renders as "20" and stops being a backlog anyone chases.
  it('caps the list at 20 and still reports the full count', async () => {
    for (let i = 0; i < 22; i += 1) await draft();
    const body = await attention();
    expect(body.unseenDrafts).toHaveLength(20);
    expect(body.unseenDraftsTotal).toBe(22);
    expect(body.total).toBe(20);
  });
});
