/**
 * ISS-1229 r13, judge-30: an Org Member's Attention page read "Inbox zero" while items waited in the
 * organisation they had open. The route capped the awaiting-input bucket at 20 across every
 * organisation (ISS-964) and the web then kept only the active organisation's rows (ISS-477), so 20
 * rows of another organisation filled the cap and the filter left none. The route now scopes every
 * bucket and every total to the organisation it is asked for, before the cap.
 *
 * ISS-1229 r14, judge-35: with 32 parks owed in one project, Attention and its badge said 20, Needs
 * you 25 and the headline "at least 32". Each bucket now carries its whole count, `total` sums them,
 * and `expand` lists a bucket whole, so every surface says one number and can reach every item.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let member: string;
let token: string;
let busy: { id: string; slug: string; orgId: string };
let quiet: { id: string; slug: string; orgId: string };
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const { meAttentionRoutes } = await import('../../src/me/attention-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/me', meAttentionRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  member = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  const owner = (await createTestUser(harness.db)).id;
  const busyOrg = await seedOrg(harness.db, owner);
  const quietOrg = await seedOrg(harness.db, owner);
  await createTestOrgMember(harness.db, { orgId: busyOrg.id, userId: member });
  await createTestOrgMember(harness.db, { orgId: quietOrg.id, userId: member });
  busy = await createTestProject(harness.db, owner, { orgId: busyOrg.id });
  quiet = await createTestProject(harness.db, owner, { orgId: quietOrg.id });
  await createTestProjectMember(harness.db, { userId: member, projectId: busy.id });
  await createTestProjectMember(harness.db, { userId: member, projectId: quiet.id });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(member);
});

/** An issue at Needs info assigned to the member, last written `ageHours` ago. */
async function waiting(projectId: string, ageHours: number): Promise<void> {
  seq += 1;
  const at = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id, created_at, updated_at)
    VALUES (${randomUUID()}, ${projectId}, ${seq}, ${`waits ${seq}`}, 'needs_info', ${member}, ${member},
            ${at}::timestamptz, ${at}::timestamptz)
  `);
}

/** Many parks at once, assigned to the member, oldest first: one statement, not one per row. */
async function waitingMany(projectId: string, n: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id, created_at, updated_at)
    SELECT gen_random_uuid(), ${projectId}, ${seq} + g, 'waits ' || (${seq} + g), 'needs_info',
           ${member}, ${member}, now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
      FROM generate_series(1, ${n}) g
  `);
  seq += n;
}

async function attention(query = '') {
  const res = await app.request(`/api/me/attention${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('the Attention read of one organisation', () => {
  it('lists that organisation’s waiting items though another organisation holds more than the cap', async () => {
    for (let i = 0; i < 25; i += 1) await waiting(busy.id, 48 - i);
    await waiting(quiet.id, 1);
    await waiting(quiet.id, 2);

    const { status, body } = await attention(`?orgId=${quiet.orgId}`);

    expect(status).toBe(200);
    const items = body.awaitingInput as Array<{ projectSlug: string }>;
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.projectSlug))).toEqual(new Set([quiet.slug]));
    expect(Object.keys(body.projectTotals as object)).toEqual([quiet.slug]);
    expect(body.total).toBe(2);
  });

  it('still reads every organisation where none is named', async () => {
    for (let i = 0; i < 3; i += 1) await waiting(busy.id, 10 - i);
    await waiting(quiet.id, 1);

    const { body } = await attention();

    expect((body.awaitingInput as unknown[]).length).toBe(4);
  });

  it('refuses an organisation that is not a uuid, by name', async () => {
    const { status, body } = await attention('?orgId=not-an-org');

    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('orgId');
  });

  it('says 32 for 32 parks owed in one project, in the total, the bucket and the project', async () => {
    await waitingMany(busy.id, 32);

    const { body } = await attention(`?orgId=${busy.orgId}`);

    expect((body.awaitingInput as unknown[]).length).toBe(20);
    expect((body.bucketTotals as Record<string, number>).awaitingInput).toBe(32);
    expect(body.total).toBe(32);
    expect((body.projectTotals as Record<string, { awaitingInput: number }>)[busy.slug]).toEqual({
      needsReview: 0,
      awaitingInput: 32,
      awaitingAsked: 0,
      failedJobs: 0,
      parkedOnly: 0,
      parkedAsked: 0,
      stuckOnly: 0,
    });
  });

  it('lists every park when Awaiting input is asked for whole, the 501st among them', async () => {
    await waitingMany(busy.id, 501);

    const capped = await attention(`?orgId=${busy.orgId}`);
    const whole = await attention(`?orgId=${busy.orgId}&expand=awaitingInput`);

    expect((capped.body.awaitingInput as unknown[]).length).toBe(20);
    const listed = whole.body.awaitingInput as Array<{ title: string }>;
    expect(listed).toHaveLength(501);
    expect(listed.map((i) => i.title)).toContain('waits 501');
    expect((whole.body.bucketTotals as Record<string, number>).awaitingInput).toBe(501);
    // The other buckets keep their caps; only the one named is read whole.
    expect((whole.body.needsReview as unknown[]).length).toBe(0);
  });

  it('refuses a bucket name it does not have, naming the ones it does', async () => {
    const { status, body } = await attention('?expand=everything');

    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('awaitingInput');
  });
});
