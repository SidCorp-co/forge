/**
 * The question park has to reach a human — against real Postgres.
 *
 * Two halves of one path: the notification row the park writes, and the
 * attention bucket that lists it. Both are asserted on ROWS, because both
 * unit lanes are blind here — `notify-transitions.test.ts` mocks the writer, and
 * `me/attention-routes.test.ts` mocks `db.select()` into a chain that ignores
 * `where`, so the bucket predicate is the one thing it can never fail on.
 *
 * An agent-filed issue has no assignee — MCP `forge_issues` cannot set one — so
 * an assignee-only rule on either half asks a question on a surface no human
 * reads. Measured 2026-08-27: 3 issues at `needs_info`, 360h median, and zero
 * human replies across all 17 parked issues.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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

  const { signUserToken } = await import('../../src/auth/jwt.js');
  authHeader = `Bearer ${await signUserToken(ownerId)}`;
});

describe('attention · the question park', () => {
  async function parkIssue(opts: {
    status?: string;
    createdBy?: string;
    assignee?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${opts.status ?? 'needs_info'},
              ${opts.createdBy ?? ownerId}, ${opts.assignee ?? null})
    `);
    return id;
  }

  interface Bucket {
    issueRef: string;
    status: string;
  }

  async function attention(): Promise<{ awaitingInput: Bucket[]; needsReview: Bucket[] }> {
    const res = await app.request('/api/me/attention', {
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { awaitingInput: Bucket[]; needsReview: Bucket[] };
  }

  async function awaitingInput(): Promise<Bucket[]> {
    return (await attention()).awaitingInput;
  }

  it('surfaces a question parked on an issue the user filed but nobody owns', async () => {
    await parkIssue({ assignee: null, createdBy: ownerId });
    const rows = await awaitingInput();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('needs_info');
  });

  it('still surfaces a park on an issue explicitly assigned to the user', async () => {
    await parkIssue({ assignee: ownerId, createdBy: otherId });
    expect(await awaitingInput()).toHaveLength(1);
  });

  // cm:guard the creator fallback applies ONLY while the issue is unowned — once someone is assigned the park is theirs, and showing it to the filer as well puts one question in two lists with one answer, which is how two people each assume the other replied.
  it('does not surface a park assigned to someone else', async () => {
    await parkIssue({ assignee: otherId, createdBy: ownerId });
    expect(await awaitingInput()).toHaveLength(0);
  });

  it('does not surface an unassigned issue the user did not file', async () => {
    await parkIssue({ assignee: null, createdBy: otherId });
    expect(await awaitingInput()).toHaveLength(0);
  });

  it('carries the other two parks through the same predicate', async () => {
    await parkIssue({ status: 'waiting', assignee: null, createdBy: ownerId });
    await parkIssue({ status: 'on_hold', assignee: null, createdBy: ownerId });
    expect(await awaitingInput()).toHaveLength(2);
  });

  // cm:why `needsReview` deliberately keeps assignee-only, so a `developed` issue the user filed and nobody owns must NOT appear here — this is the boundary of the change and it regresses silently.
  it('leaves needs_review assignee-only', async () => {
    await parkIssue({ status: 'developed', assignee: null, createdBy: ownerId });
    expect((await attention()).needsReview).toHaveLength(0);
  });
});

describe('the park notification', () => {
  async function issueFiledBy(userId: string, status: string): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId})
    `);
    return id;
  }

  async function move(issueId: string, from: string, to: string): Promise<void> {
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerTransitionNotifications } = await import(
      '../../src/notifications/notify-transitions.js'
    );
    const bus = new HooksBus();
    registerTransitionNotifications(bus);
    await harness.db.execute(sql`UPDATE issues SET status = ${to} WHERE id = ${issueId}`);
    const result = await bus.emit('transition', {
      issueId,
      projectId,
      actor: { type: 'device', id: randomUUID() },
      from,
      to,
      reopenCount: 0,
    } as never);
    expect(result.failures).toEqual([]);
  }

  async function inbox(
    userId: string,
  ): Promise<Array<{ key: string | null; resolved: boolean; severity: string }>> {
    const rows = await harness.db.execute(sql`
      SELECT resolution_key, resolved_at, severity FROM notifications
      WHERE user_id = ${userId} AND type = 'issue_status_changed'
      ORDER BY created_at
    `);
    return rows.map((r) => ({
      key: (r as { resolution_key: string | null }).resolution_key,
      resolved: (r as { resolved_at: Date | null }).resolved_at !== null,
      severity: (r as { severity: string }).severity,
    }));
  }

  it('writes a notification to the human who filed the issue the driver parked', async () => {
    const issueId = await issueFiledBy(ownerId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    expect(await inbox(ownerId)).toEqual([
      { key: `issue:${issueId}:question`, resolved: false, severity: 'warning' },
    ]);
  });

  it('leaves it unresolved while the issue is still parked', async () => {
    const issueId = await issueFiledBy(ownerId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    expect((await inbox(ownerId))[0]?.resolved).toBe(false);
  });

  // cm:guard the answer restarts the driver at AUTONOMOUS_ENTRY_STATUS (`open`), which is NOT in HEALTHY_STATUSES and never becomes healthy on its own — so a health-gated resolve leaves the question lit from the answer all the way to `developed`, on exactly the issues someone did reply to.
  it('resolves it on the answer, which lands on `open` and is not a healthy status', async () => {
    const issueId = await issueFiledBy(ownerId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    await move(issueId, 'needs_info', 'open');
    expect((await inbox(ownerId))[0]?.resolved).toBe(true);
  });

  // cm:guard a `waiting` park and a `needs_info` park on ONE issue must not share a resolution key: `statusResolutionKey` is per-issue, so answering the question would stamp the `waiting` row too and silently retire a park no human ever addressed.
  it('answering the question leaves a waiting park on the same issue lit', async () => {
    const issueId = await issueFiledBy(ownerId, 'in_progress');
    await move(issueId, 'in_progress', 'waiting');
    await move(issueId, 'waiting', 'needs_info');
    await move(issueId, 'needs_info', 'open');
    const rows = await inbox(ownerId);
    const waiting = rows.find((r) => r.key === `issue:${issueId}:status`);
    const question = rows.find((r) => r.key === `issue:${issueId}:question`);
    expect(question?.resolved).toBe(true);
    expect(waiting?.resolved).toBe(false);
  });

  it('does not notify the actor about their own move', async () => {
    const issueId = await issueFiledBy(otherId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    expect(await inbox(ownerId)).toEqual([]);
  });
});
