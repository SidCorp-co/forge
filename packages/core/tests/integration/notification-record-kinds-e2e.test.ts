/**
 * ISS-1063 — the record/delivery split, against real Postgres.
 *
 * The unit suites prove the routes' contracts against a stub; a stub cannot tell a
 * predicate over `state` from a predicate over `read`, and that distinction IS this
 * issue. So every counting criterion is answered here, on rows the migration's own
 * schema accepted, through the same HTTP routes the bell calls.
 *
 * Measured on the beta replica 2026-09-16 and the reason this file exists: the owner's
 * bell read 36 unread against 5663 unresolved. One number answered "have you looked",
 * the other "is it still happening", and the product showed the first while its schema
 * documented the second.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  recordAndDeliver: typeof import('../../src/notifications/deliver.js').recordAndDeliver;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resolveNotifications: typeof import('../../src/notifications/auto-resolve.js').resolveNotifications;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  EVALUATION_MS: typeof import('../../src/notifications/deliver.js').EVALUATION_MS;
};

describe('notifications · records, deliveries and a count that is still true', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
  let ownerId: string;
  let otherId: string;
  let projectId: string;
  let authHeader: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const deliver = await import('../../src/notifications/deliver.js');
    const autoResolve = await import('../../src/notifications/auto-resolve.js');
    mods = {
      recordAndDeliver: deliver.recordAndDeliver,
      EVALUATION_MS: deliver.EVALUATION_MS,
      resolveNotifications: autoResolve.resolveNotifications,
    };

    const { notificationRoutes } = await import('../../src/notifications/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    app = new Hono<{
      Variables: import('../../src/middleware/request-id.js').RequestIdVars;
    }>();
    app.use('*', requestId());
    app.route('/api/notifications', notificationRoutes);
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
    projectId = (await createTestProject(harness.db, ownerId)).id;
    const { signUserToken } = await import('../../src/auth/jwt.js');
    authHeader = `Bearer ${await signUserToken(ownerId)}`;
  });

  async function openCount(): Promise<number> {
    const res = await app.request('/api/notifications/open-count', {
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { count: number }).count;
  }

  interface BellRow {
    id: string;
    title: string;
    readAt: string | null;
    members: number;
    openMembers: number;
    resolvedNotice: boolean;
    type: string;
  }

  async function bell(): Promise<BellRow[]> {
    const res = await app.request('/api/notifications', {
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: BellRow[] }).items;
  }

  /** A `pipeline_wedge` — a condition with no pending duration, so it fires at once. */
  async function wedge(key: string, title: string, recipients = [ownerId]) {
    return mods.recordAndDeliver({
      recipients,
      projectId,
      type: 'pipeline_wedge',
      title,
      resolutionKey: key,
    });
  }

  // ─── the count itself ──────────────────────────────────────────────────────

  it('counts records still true for the reader, not deliveries they have not opened', async () => {
    await wedge('wedge:a', 'job a is wedged');
    await wedge('wedge:b', 'job b is wedged');
    expect(await openCount()).toBe(2);
  });

  it('opening a notification leaves the count unchanged', async () => {
    await wedge('wedge:a', 'job a is wedged');
    const [row] = await bell();
    expect(row?.readAt).toBeNull();

    const res = await app.request(`/api/notifications/${row?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ read: true }),
    });
    expect(res.status).toBe(200);

    const [after] = await bell();
    expect(after?.readAt).not.toBeNull();
    expect(await openCount()).toBe(1);
  });

  it('resolving a record leaves the read state it already had', async () => {
    await wedge('wedge:a', 'job a is wedged');
    const [row] = await bell();
    await app.request(`/api/notifications/${row?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ read: true }),
    });

    await mods.resolveNotifications('wedge:a');

    const rows = await bell();
    const original = rows.find((r) => r.id === row?.id);
    expect(original?.readAt).not.toBeNull();
    expect(await openCount()).toBe(0);
  });

  it('reading a record leaves its resolved state alone', async () => {
    await wedge('wedge:a', 'job a is wedged');
    const [row] = await bell();
    await app.request(`/api/notifications/${row?.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ read: true }),
    });
    const [{ n }] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE resolved_at IS NOT NULL`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  // ─── signals ───────────────────────────────────────────────────────────────

  it('a signal carries no resolution key, and never counts as open', async () => {
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'issue_status_changed',
      title: 'ISS-1 moved to developed',
    });
    expect(await openCount()).toBe(0);
    expect((await bell())[0]?.type).toBe('issue_status_changed');
  });

  // cm:guard the CHECK is what makes the kind mean something rather than describe something — without it a signal can be given a resolution key by any future emitter and silently rejoin the pile this issue emptied
  it('the database refuses a signal row carrying a resolution key', async () => {
    // The constraint's own name has to reach the reader: drizzle wraps the driver error,
    // so the assertion walks to the cause rather than matching the wrapper's text.
    const refusal = await harness.db
      .execute(
        sql`INSERT INTO notifications (project_id, type, kind, tier, state, title, resolution_key)
            VALUES (${projectId}, 'issue_status_changed', 'signal', 'log', 'emitted', 't', 'k')`,
      )
      .then(
        () => null,
        (err: { cause?: { message?: string }; message?: string }) =>
          `${err.message ?? ''} ${err.cause?.message ?? ''}`,
      );
    expect(refusal).toMatch(/notifications_signal_has_no_resolve_state/);
  });

  // ─── who may close what ────────────────────────────────────────────────────

  it('no request a person can send resolves a condition', async () => {
    await wedge('wedge:a', 'job a is wedged');
    const [row] = await bell();
    for (const path of ['done', 'dismiss']) {
      const res = await app.request(`/api/notifications/${row?.id}/${path}`, {
        method: 'POST',
        headers: { authorization: authHeader },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: 0 });
    }
    expect(await openCount()).toBe(1);
  });

  it('a task has a request that closes it, and then stops counting', async () => {
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'intake_pending',
      title: 'ISS-9 needs a decision',
    });
    expect(await openCount()).toBe(1);
    const [row] = await bell();
    const res = await app.request(`/api/notifications/${row?.id}/done`, {
      method: 'POST',
      headers: { authorization: authHeader },
    });
    expect(await res.json()).toEqual({ closed: 1 });
    expect(await openCount()).toBe(0);
  });

  // ─── grouping ──────────────────────────────────────────────────────────────

  it('fifteen conditions raised in one tick reach one reader as one notification', async () => {
    for (let i = 0; i < 15; i += 1) {
      await mods.recordAndDeliver({
        recipients: [ownerId],
        projectId,
        type: 'issue_stranded',
        title: `ISS-${i} is parked`,
        resolutionKey: `stranded:${i}`,
        groupKey: 'sweep:stranded:1',
        groupTitle: '15 issues are parked with merged code',
      });
      // A condition declaring a pending duration is not delivered on its first
      // evaluation — this is the second, which is what the detector's next tick is.
      await mods.recordAndDeliver({
        recipients: [ownerId],
        projectId,
        type: 'issue_stranded',
        title: `ISS-${i} is parked`,
        resolutionKey: `stranded:${i}`,
        groupKey: 'sweep:stranded:1',
        groupTitle: '15 issues are parked with merged code',
      });
    }
    await harness.db.execute(
      sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
    );
    for (let i = 0; i < 15; i += 1) {
      await mods.recordAndDeliver({
        recipients: [ownerId],
        projectId,
        type: 'issue_stranded',
        title: `ISS-${i} is parked`,
        resolutionKey: `stranded:${i}`,
        groupKey: 'sweep:stranded:1',
        groupTitle: '15 issues are parked with merged code',
      });
    }

    const rows = await bell();
    expect(rows).toHaveLength(1);
    // …and it names the cause the fifteen share, and how many it holds.
    expect(rows[0]?.title).toBe('15 issues are parked with merged code');
    expect(rows[0]?.members).toBe(15);
    expect(rows[0]?.openMembers).toBe(15);
    expect(await openCount()).toBe(15);

    // Resolving ONE member lowers the count by one, and the delivery stays.
    await mods.resolveNotifications('stranded:3');
    expect(await openCount()).toBe(14);
    const after = await bell();
    expect(after.find((r) => r.members === 15)?.openMembers).toBe(14);
  });

  it('one condition told to six admins is one record and six deliveries', async () => {
    const admins = [ownerId, otherId];
    await wedge('wedge:shared', 'the pipeline is wedged', admins);
    const [{ records, deliveries }] = (await harness.db.execute(sql`
      SELECT (SELECT count(*)::int FROM notifications) AS records,
             (SELECT count(*)::int FROM notification_deliveries) AS deliveries
    `)) as unknown as [{ records: number; deliveries: number }];
    expect({ records, deliveries }).toEqual({ records: 1, deliveries: 2 });
  });

  // ─── inhibition ────────────────────────────────────────────────────────────

  it('a condition whose root cause is firing delivers nothing while it fires', async () => {
    await wedge('wedge:root', 'the pipeline is wedged');
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'issue_stranded',
      title: 'ISS-1 is parked',
      resolutionKey: 'stranded:1',
    });
    const rows = await bell();
    expect(rows.map((r) => r.type)).toEqual(['pipeline_wedge']);
  });

  it('when the root resolves, a child that cleared meanwhile tells nobody', async () => {
    await wedge('wedge:root', 'the pipeline is wedged');
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'issue_stranded',
      title: 'ISS-1 is parked',
      resolutionKey: 'stranded:1',
    });
    await mods.resolveNotifications('wedge:root');

    const { reevaluateConditions } = await import('../../src/notifications/reevaluate.js');
    // The child returns to `pending` rather than being delivered…
    await reevaluateConditions(new Date());
    const [{ state }] = (await harness.db.execute(
      sql`SELECT state FROM notifications WHERE type = 'issue_stranded'`,
    )) as unknown as [{ state: string }];
    expect(state).toBe('pending');
    expect(await openCount()).toBe(0);

    // …and because its producer never emits it again, the next sweep drops it.
    await harness.db.execute(
      sql`UPDATE notifications SET last_seen_at = now() - interval '1 hour' WHERE type = 'issue_stranded'`,
    );
    await reevaluateConditions(new Date());
    const [{ n }] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'issue_stranded'`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  // ─── the pending duration ──────────────────────────────────────────────────

  it('a condition declaring a pending duration delivers nothing on first sight', async () => {
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'retry_rescue_threshold',
      title: 'retries are climbing',
      resolutionKey: 'rescue:1',
    });
    expect(await bell()).toEqual([]);
    expect(await openCount()).toBe(0);
  });

  it('…and is delivered once it is still true after the duration elapses', async () => {
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'retry_rescue_threshold',
      title: 'retries are climbing',
      resolutionKey: 'rescue:1',
    });
    await harness.db.execute(
      sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
    );
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'retry_rescue_threshold',
      title: 'retries are climbing',
      resolutionKey: 'rescue:1',
    });
    expect(await openCount()).toBe(1);
  });

  // ─── resolved notices ──────────────────────────────────────────────────────

  it('a condition that clears tells the people who were told it started', async () => {
    await wedge('wedge:a', 'job a is wedged', [ownerId, otherId]);
    await mods.resolveNotifications('wedge:a');
    const rows = await bell();
    const notice = rows.find((r) => r.resolvedNotice);
    expect(notice?.title).toMatch(/^Resolved — /);
    // …and nobody else: a record nobody was told about announces nothing.
    await mods.recordAndDeliver({
      recipients: [ownerId],
      projectId,
      type: 'retry_rescue_threshold',
      title: 'retries are climbing',
      resolutionKey: 'rescue:quiet',
    });
    await mods.resolveNotifications('rescue:quiet');
    const after = await bell();
    expect(after.filter((r) => r.resolvedNotice)).toHaveLength(1);
  });

  // ─── silences ──────────────────────────────────────────────────────────────

  it('a reader can silence a set of records by matcher for a stated period', async () => {
    const res = await app.request('/api/notifications/silences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({
        type: 'pipeline_wedge',
        projectId,
        reason: 'working on it',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(res.status).toBe(201);

    await wedge('wedge:a', 'job a is wedged');
    expect(await bell()).toEqual([]);
    // The RECORD still exists — the system knows; nobody was told.
    const [{ n }] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE type = 'pipeline_wedge'`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('a silence stops applying once its period has ended', async () => {
    const res = await app.request('/api/notifications/silences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({
        type: 'pipeline_wedge',
        projectId,
        reason: 'working on it',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(res.status).toBe(201);
    await harness.db.execute(
      sql`UPDATE notification_silences SET expires_at = now() - interval '1 minute'`,
    );

    await wedge('wedge:a', 'job a is wedged');
    expect(await bell()).toHaveLength(1);
  });

  // ─── the metric this change was not allowed to move ────────────────────────

  // cm:guard VISION §1 metric ② counts one row per `pipeline_wedge` straight off this table (`issue_intervention_events`, migration 0117). Consolidating wedge rows would move a north-star metric in silence, so the delivery layer must leave one record per wedge identity — this is the case that says so.
  it('the interventions view still counts one row per wedge', async () => {
    await wedge('wedge:a', 'job a is wedged', [ownerId, otherId]);
    await wedge('wedge:b', 'job b is wedged', [ownerId, otherId]);
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 1, 'an issue', 'open', ${ownerId})
    `);
    await harness.db.execute(
      sql`UPDATE notifications SET issue_id = ${issueId} WHERE type = 'pipeline_wedge'`,
    );
    const [{ n }] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM issue_intervention_events WHERE issue_id = ${issueId}`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(2);
  });
});
