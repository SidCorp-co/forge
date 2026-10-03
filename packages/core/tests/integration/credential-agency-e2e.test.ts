/**
 * Who acted is read off the credential a write arrived on, through every record the write leaves:
 * the issue's creator, the activity rows (the outbox-carried status change included), the kernel
 * audit, and the comment inbox that owes a person a reply.
 *
 * Three credentials separate the cases. A person's own unbound token, which is that person. An
 * agent account's token, which is that agent. And a token bound to a person's paired box, which is
 * the box's — an agent — with the person kept as the principal behind it. Before this change the
 * third read as the person everywhere, so every write a master pane made with its checkout token
 * said a person had made it.
 *
 * Postgres is real because the outbox trigger, the NOT NULL without a default and the CHECK that
 * refuse an unrecorded agency are all things the database does.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;
let readOwedComments: typeof import('../../src/devices/comment-inbox.js').readOwedComments;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ mintPat } = await import('../../src/auth/pat.js'));
  accounts = await import('../../src/orgs/agent-accounts.js');
  ({ drainOutboxOnce } = await import('../../src/pipeline/outbox-worker.js'));
  ({ readOwedComments } = await import('../../src/devices/comment-inbox.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let orgId: string;
let personId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${personId}`);
  const project = await createTestProject(harness.db, personId);
  projectId = project.id;
  orgId = project.orgId;
  await harness.db.execute(
    sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${orgId} AND user_id = ${personId}`,
  );
  await createTestProjectMember(harness.db, { userId: personId, projectId, role: 'admin' });
});

async function personToken(): Promise<string> {
  return (await mintPat({ userId: personId, name: `terminal-${randomUUID()}` })).plaintext;
}

/** A token bound to a box the person paired, as a device credential or a checkout token is. */
async function boxToken(): Promise<{ token: string; deviceId: string }> {
  const device = await createTestDevice(harness.db, personId);
  const { plaintext } = await mintPat({
    userId: personId,
    name: `checkout-${randomUUID()}`,
    projectIds: [projectId],
    deviceId: device.id,
  });
  return { token: plaintext, deviceId: device.id };
}

async function agentToken(): Promise<{ token: string; userId: string }> {
  const created = await accounts.createAgentAccount({
    orgId,
    projectIds: [projectId],
    handle: `master-${randomUUID().slice(0, 8)}`,
  });
  return { token: created.plaintext, userId: created.agent.userId };
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as Record<string, unknown>,
  };
}

/** File, edit, move and comment on one issue with one credential, then read every record. */
async function actWith(token: string) {
  const created = await call(token, 'POST', `/api/projects/${projectId}/issues`, {
    title: 'filed with this credential',
    priority: 'low',
    status: 'open',
  });
  expect(created.status).toBe(201);
  const id = created.json.id as string;
  expect((await call(token, 'PATCH', `/api/issues/${id}`, { title: 'edited' })).status).toBe(200);
  const moved = await call(token, 'POST', `/api/issues/${id}/transition`, {
    toStatus: 'on_hold',
    reason: 'parked for the next window',
  });
  expect(moved.status).toBe(200);
  await drainOutboxOnce();
  expect(
    (await call(token, 'POST', `/api/issues/${id}/comments`, { body: 'a word on the thread' }))
      .status,
  ).toBe(201);

  const activity = (await harness.db.execute(sql`
    SELECT action, actor_type, actor_id, actor_agency FROM activity_log
    WHERE issue_id = ${id} AND action IN ('issue.created', 'issue.updated', 'issue.statusChanged')
    ORDER BY created_at`)) as unknown as Array<Record<string, string>>;
  const [issue] = (await harness.db.execute(sql`
    SELECT created_by_id, created_by_device_id FROM issues WHERE id = ${id}`)) as unknown as Array<
    Record<string, string | null>
  >;
  const kernel = (await harness.db.execute(sql`
    SELECT actor_agency FROM kernel_transitions WHERE entity = 'issue' AND entity_id = ${id}`)) as unknown as Array<
    Record<string, string>
  >;
  const [comment] = (await harness.db.execute(sql`
    SELECT author_id, author_device_id FROM comments
    WHERE issue_id = ${id} AND body = 'a word on the thread'`)) as unknown as Array<
    Record<string, string | null>
  >;
  const listed = await call(token, 'GET', `/api/projects/${projectId}/issues?limit=100`);
  const row = (listed.json.items as Array<Record<string, unknown>>).find((r) => r.id === id);
  const owed = (await readOwedComments(projectId)).items.map((o) => o.issueId);
  return { id, activity, issue, kernel, comment, row, owed };
}

describe('a write is attributed to who made it, read off the credential', () => {
  it("an agent account's token is the agent on every record", async () => {
    const agent = await agentToken();
    const r = await actWith(agent.token);

    expect(r.activity.map((a) => a.action)).toEqual([
      'issue.created',
      'issue.updated',
      'issue.statusChanged',
    ]);
    expect(new Set(r.activity.map((a) => a.actor_agency))).toEqual(new Set(['agent']));
    expect(r.issue?.created_by_id).toBe(agent.userId);
    expect(r.row?.creatorIsAgent).toBe(true);
    expect(r.kernel.map((k) => k.actor_agency)).toEqual(['agent']);
    expect(r.owed).not.toContain(r.id);
  });

  it("a person's paired box is an agent on every record, with the person kept behind it", async () => {
    const box = await boxToken();
    const r = await actWith(box.token);

    expect(r.activity.map((a) => [a.action, a.actor_type, a.actor_id, a.actor_agency])).toEqual([
      ['issue.created', 'user', personId, 'agent'],
      ['issue.updated', 'user', personId, 'agent'],
      ['issue.statusChanged', 'user', personId, 'agent'],
    ]);
    expect(r.issue).toEqual({ created_by_id: personId, created_by_device_id: box.deviceId });
    expect(r.row?.creatorIsAgent).toBe(true);
    expect(r.row?.createdById).toBe(personId);
    expect(r.kernel.map((k) => k.actor_agency)).toEqual(['agent']);
    expect(r.comment).toEqual({ author_id: personId, author_device_id: box.deviceId });
    expect(r.owed, "a box's comment is an agent's, and owes nobody a reply").not.toContain(r.id);
  });

  it("a person's own token stays the person on every record, and their comment is owed", async () => {
    const r = await actWith(await personToken());

    expect(r.activity.map((a) => [a.actor_id, a.actor_agency])).toEqual([
      [personId, 'human'],
      [personId, 'human'],
      [personId, 'human'],
    ]);
    expect(r.issue).toEqual({ created_by_id: personId, created_by_device_id: null });
    expect(r.row?.creatorIsAgent).toBe(false);
    expect(r.kernel.map((k) => k.actor_agency)).toEqual(['human']);
    expect(r.comment).toEqual({ author_id: personId, author_device_id: null });
    expect(r.owed).toContain(r.id);
  });
});

describe('a record that does not say who acted is refused, never written as a person', () => {
  async function anIssue(): Promise<string> {
    const [row] = (await harness.db.execute(sql`
      INSERT INTO issues (project_id, created_by_id, iss_seq, title, status)
      VALUES (${projectId}, ${personId}, 1, 'subject', 'open') RETURNING id`)) as unknown as Array<{
      id: string;
    }>;
    if (!row) throw new Error('the issue insert returned no row');
    return row.id;
  }

  it('the activity log refuses a row with no agency', async () => {
    const id = await anIssue();
    await expect(
      harness.db.execute(sql`
        INSERT INTO activity_log (issue_id, actor_type, actor_id, action)
        VALUES (${id}, 'user', ${personId}, 'issue.updated')`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/actor_agency/) } });
  });

  it('the kernel audit refuses a row with no agency', async () => {
    await expect(
      harness.db.execute(sql`
        INSERT INTO kernel_transitions (entity, entity_id, to_status, actor_type, source)
        VALUES ('job', ${randomUUID()}, 'failed', 'user', 'test')`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/actor_agency/) } });
  });

  it('a status change naming a user and no agency is refused by the outbox', async () => {
    const id = await anIssue();
    await expect(
      harness.db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT set_config('pipeline.actor_id', ${personId}, true),
                 set_config('pipeline.actor_type', 'user', true)`);
        await tx.execute(sql`UPDATE issues SET status = 'on_hold' WHERE id = ${id}`);
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/pipeline_outbox_user_actor_has_agency/) },
    });
  });
});
