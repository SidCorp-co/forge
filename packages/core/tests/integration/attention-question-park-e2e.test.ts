/**
 * The question park has to reach a human — against real Postgres — and a pause
 * nobody must answer has to stay out of it.
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
    blockerKind?: string | null;
    questionId?: string | null;
    cost?: { claimsHeld: number; workspacesPinned: number; dependents: number };
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

  it('carries the other park that asks a human through the same predicate', async () => {
    await parkIssue({ status: 'waiting', assignee: null, createdBy: ownerId });
    const rows = await awaitingInput();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('waiting');
  });

  // cm:guard ISS-970 — the negative case, and the one the unit lane cannot hold: `on_hold` is a pause a person CHOSE, and `cancel` sets it with the `parkIssue: true` default, so a bucket that carries it manufactures one "a human is needed" row per cancelled duplicate run. Measured 2026-09-07: 3 cancels, 3 rows, 0 questions. Widening the predicate back turns this file red before any screen shows the alarm again.
  it('does not surface a deliberate pause as a question for a human', async () => {
    await parkIssue({ status: 'on_hold', assignee: null, createdBy: ownerId });
    await parkIssue({ status: 'on_hold', assignee: ownerId, createdBy: otherId });
    expect(await awaitingInput()).toHaveLength(0);
  });

  it('still surfaces a real question filed beside a deliberate pause', async () => {
    await parkIssue({ status: 'on_hold', assignee: null, createdBy: ownerId });
    await parkIssue({ status: 'needs_info', assignee: null, createdBy: ownerId });
    const rows = await awaitingInput();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('needs_info');
  });

  // cm:why `needsReview` deliberately keeps assignee-only, so a `developed` issue the user filed and nobody owns must NOT appear here — this is the boundary of the change and it regresses silently.
  it('leaves needs_review assignee-only', async () => {
    await parkIssue({ status: 'developed', assignee: null, createdBy: ownerId });
    expect((await attention()).needsReview).toHaveLength(0);
  });
  // cm:why the ROUTE half of criterion 53. `selectAwaitingInput` grew the cost and the blocker, and `issueItem` is shared by six buckets — so the fields reached the selector and stopped there, which reads exactly like a query that never returned them.
  it('serves the cost and the blocker on the awaiting bucket', async () => {
    const issueId = await parkIssue({ assignee: null, createdBy: ownerId });
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'open', 'human', '[]'::jsonb, 2, 1, 3)
    `);

    const [row] = await awaitingInput();

    expect(
      row?.cost,
      'the reader is shown what the wait costs, in the same numbers the order was computed from',
    ).toEqual({ claimsHeld: 2, workspacesPinned: 1, dependents: 3 });
    expect(row?.blockerKind).toBe('human');
  });

  // cm:why the id is what tells a DECISION apart from a `waiting` a person typed, and both land in this one bucket looking identical — without it the row can say a human is needed and not that there is a row they can settle (ISS-980 criterion 25).
  it('names the open question on the awaiting bucket', async () => {
    const issueId = await parkIssue({ assignee: null, createdBy: ownerId });
    const questionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${questionId}, ${projectId}, ${issueId}, 'open', 'human', '[]'::jsonb)
    `);

    const [row] = await awaitingInput();
    expect(row?.questionId).toBe(questionId);
  });

  // cm:guard the falsifying half: a park a PERSON entered has no question row, and a non-null id here would send that reader to a screen with nothing on it. NULL is the honest answer, exactly as it is for `blockerKind`.
  it('names no question on a park a person entered by hand', async () => {
    await parkIssue({ status: 'waiting', assignee: null, createdBy: ownerId });
    const [row] = await awaitingInput();
    expect(row?.questionId).toBeNull();
  });

  // cm:guard an ANSWERED question costs nothing and blocks nobody, so it must not be named here either — the id and the kind are read through the same `status='open'` predicate, and a surface offering a settled decision to answer is worse than one offering none.
  it('names no question once the decision has been settled', async () => {
    const issueId = await parkIssue({ assignee: null, createdBy: ownerId });
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, 'answered', 'human', '[]'::jsonb)
    `);

    const [row] = await awaitingInput();
    expect(row?.questionId).toBeNull();
    expect(row?.blockerKind).toBeNull();
  });

  // cm:guard the OTHER buckets must NOT grow these keys: `needsReview` is not a wait anybody is paying for, and a cost of three zeros there reads as a measured zero rather than as not-applicable.
  it("leaves the other buckets' shape alone", async () => {
    await parkIssue({ status: 'developed', assignee: ownerId, createdBy: ownerId });
    const { needsReview } = await attention();

    expect(needsReview).toHaveLength(1);
    expect(needsReview[0]).not.toHaveProperty('cost');
    expect(needsReview[0]).not.toHaveProperty('blockerKind');
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
    // ISS-1063 — "this person's inbox" is a join now: the record says what is true, the
    // delivery says who was told. A query still going straight at `notifications.user_id`
    // would be asking the old question.
    const rows = await harness.db.execute(sql`
      SELECT n.resolution_key, n.resolved_at, n.severity
        FROM notification_deliveries d
        JOIN notification_delivery_members m ON m.delivery_id = d.id
        JOIN notifications n ON n.id = m.notification_id
       WHERE d.user_id = ${userId} AND n.type = 'issue_status_changed'
       ORDER BY n.created_at
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
    expect(await inbox(ownerId)).toEqual([{ key: null, resolved: false, severity: 'warning' }]);
  });

  /*
   * ISS-1063 — three cases that used to live here are GONE, and what they asserted is worth
   * stating rather than quietly dropping.
   *
   * They held that a park notification carried `issue:<id>:question`, that answering the
   * question stamped it resolved, and that a `waiting` park on the same issue kept its own
   * key so one answer did not retire the other. All three were about a `resolution_key` on
   * an `issue_status_changed` row, and that type is now a `signal`: an issue moved, and an
   * event cannot stop having happened. The record layer refuses the key structurally (a
   * CHECK constraint) and `deliver.ts` refuses it by name, so there is no state left for
   * those cases to assert.
   *
   * What replaced the behaviour: the park reaches its human through `GET /me/attention`'s
   * `awaitingInput` bucket, which derives from the issue's LIVE status and self-clears on
   * the answer — no read flag, no key, nothing to leave lit. The cases below this comment
   * still hold the two things that survive: the filer is told, and the actor is not.
   */
  it('carries no resolution key, because a status change is an event and cannot resolve', async () => {
    const issueId = await issueFiledBy(ownerId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    await move(issueId, 'needs_info', 'open');
    // `open` is not in NOTIFY_ON_STATUS, so the answer writes no second row: what is asserted
    // is that the park's own row carries no key and is still unresolved after the answer.
    const rows = await inbox(ownerId);
    expect(rows.map((r) => r.key)).toEqual([null]);
    expect(rows.every((r) => !r.resolved)).toBe(true);
  });

  it('does not notify the actor about their own move', async () => {
    const issueId = await issueFiledBy(otherId, 'in_progress');
    await move(issueId, 'in_progress', 'needs_info');
    expect(await inbox(ownerId)).toEqual([]);
  });
});
