// ISS-975 — a CHARACTERIZATION of all five glance metrics on GET /api/admin/overview,
// written before the bucketing machinery moved to admin/metric-series.ts and
// asserting the exact figures the console showed beforehand.
//
// The equalities between /overview and /metrics/:metric/timeseries cannot stand
// in for this: both surfaces read through the SAME moved code, so a reader that
// changed what it counts leaves them agreeing on the same wrong number. This
// file is the only thing that goes red for that.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Glance = { value: number | null; deltaPct: number | null; spark: number[] };

const CUR_H = 3;
const BASE_H = 30;

/** Every figure the seeding below produces, so the expectations read as one
 *  table rather than as fifteen scattered numbers. */
const EXPECTED: Record<string, { value: number; deltaPct: number; spark: number }> = {
  leadTimeMinutes: { value: 30, deltaPct: 200, spark: 30 },
  interventionsPerClosed: { value: 0.25, deltaPct: -50, spark: 0.25 },
  costPerClosedUsd: { value: 2, deltaPct: 100, spark: 2 },
  successRatePct: { value: 75, deltaPct: 50, spark: 75 },
  signupsWindow: { value: 3, deltaPct: 200, spark: 3 },
};

async function insertIssue(
  harness: TestDatabase,
  args: { projectId: string; createdById: string; issSeq: number; createdAt?: string },
) {
  const id = randomUUID();
  const created = args.createdAt ? sql`${args.createdAt}::timestamptz` : sql`now()`;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at)
    VALUES (${id}, ${args.projectId}, ${args.issSeq}, ${'t'}, ${'open'}, ${args.createdById}, ${created})
  `);
  return id;
}

async function insertActivity(
  harness: TestDatabase,
  args: { issueId: string; actorId: string; to: string; at: string },
) {
  await harness.db.execute(sql`
    INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
    VALUES (${randomUUID()}, ${args.issueId}, ${'user'}, ${args.actorId}, ${'issue.statusChanged'},
            ${JSON.stringify({ from: 'x', to: args.to })}::jsonb, ${args.at}::timestamptz)
  `);
}

async function labelIssue(harness: TestDatabase, issueId: string, projectId: string, name: string) {
  const labelId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO labels (id, project_id, name, color) VALUES (${labelId}, ${projectId}, ${name}, ${'#000'})
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_labels (issue_id, label_id) VALUES (${issueId}, ${labelId})
  `);
}

/**
 * The spark holds `expected` in exactly one bucket and zero everywhere else.
 *
 * The bucket's INDEX is deliberately asserted as a range rather than a constant.
 * Every seeded row is pinned to an absolute timestamp taken CUR_H hours before
 * the test's own clock reading, while the route floors its buckets against a
 * `new Date()` taken a moment later — so when that moment happens to cross an
 * hour boundary the same row lands one bucket earlier. Pinning the index buys a
 * ~1-in-3600 red run and covers nothing the value assertion does not: a reader
 * that lost the UTC bucket alignment joins no boundary at all and densifies to
 * all-zero, which the `toEqual([expected])` below catches.
 */
function expectSparkPlacedOnce(spark: number[], expected: number): void {
  expect(spark).toHaveLength(24);
  expect(spark.filter((v) => v !== 0)).toEqual([expected]);
  const index = spark.findIndex((v) => v !== 0);
  expect(index).toBeGreaterThanOrEqual(23 - CUR_H - 1);
  expect(index).toBeLessThanOrEqual(23 - CUR_H);
}

describe('GET /api/admin/overview — the five glance metrics (ISS-975)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let glance: Record<string, Glance>;

  const ADMIN_EMAIL = 'admin@test.forge.local';

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
    // cm:guard `env.ts` freezes `env` at first import, so ADMIN_EMAILS must be set BEFORE the dynamic import below — set it after and requireAdmin reads an empty allow-list and every case in this file 403s (ISS-816)
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    const { adminAggregateRoutes } = await import('../../src/admin/aggregate-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminAggregateRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  // cm:guard seeded ONCE and read ONCE: /overview reads live `now()`, so a second request after more seeding would measure a different span and the figures below would stop being one consistent reading.
  beforeEach(async () => {
    await truncateAll(harness.db);
    glance = await seedAndRead();
  });

  async function verifiedUser(email: string) {
    const user = await createTestUser(harness.db, { email });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function seedAndRead(): Promise<Record<string, Glance>> {
    const admin = await verifiedUser(ADMIN_EMAIL);
    const owner = await verifiedUser('glance-owner@test.forge.local');
    const project = await createTestProject(harness.db, owner.id);

    const t0 = Date.now();
    const at = (hoursAgo: number, minutesAgo = 0) =>
      new Date(t0 - hoursAgo * 3_600_000 - minutesAgo * 60_000).toISOString();
    const cur = at(CUR_H);
    const base = at(BASE_H);

    // cm:why every user the harness already made — the admin, this owner — carries `created_at = now()`, a REAL signup inside the current window landing in a different spark bucket than the seeded ones. Pushed clear of the 48h span the glance reads so `signupsWindow` measures only what this file planted.
    await harness.db.execute(sql`UPDATE users SET created_at = now() - interval '200 hours'`);

    for (const [i, when] of [cur, cur, cur, base].entries()) {
      await harness.db.execute(sql`
        INSERT INTO users (id, email, created_at)
        VALUES (${randomUUID()}, ${`sig-${i}@test.forge.local`}, ${when}::timestamptz)
      `);
    }

    for (const [issSeq, when, ageMin] of [
      [1, cur, 40],
      [2, cur, 20],
      [3, base, 10],
    ] as const) {
      const id = await insertIssue(harness, {
        projectId: project.id,
        createdById: owner.id,
        issSeq,
        createdAt: at(when === cur ? CUR_H : BASE_H, ageMin),
      });
      await insertActivity(harness, {
        issueId: id,
        actorId: owner.id,
        to: 'in_progress',
        at: when,
      });
    }

    // cm:guard the three close spellings are seeded on purpose: `activity_log` is HISTORY and holds rows written while the rung was called `released` (renamed 2026-09-10, migration 0228). Seeding only `closed` leaves `bucketedResolved`'s status list unguarded, and dropping a spelling there silently halves the denominator two glance metrics divide by.
    for (const [issSeq, when, to, lane] of [
      [10, cur, 'closed', 'kernel-hardening'],
      [12, cur, 'closed', null],
      [13, cur, 'released', null],
      [14, cur, 'awaiting_release', null],
      [11, base, 'released', 'onboarding'],
      [15, base, 'awaiting_release', null],
    ] as const) {
      const id = await insertIssue(harness, {
        projectId: project.id,
        createdById: owner.id,
        issSeq,
      });
      if (lane) await labelIssue(harness, id, project.id, lane);
      await insertActivity(harness, { issueId: id, actorId: owner.id, to, at: when });
    }

    for (const [cost, when] of [
      [8, cur],
      [2, base],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at)
        VALUES (${randomUUID()}, ${project.id}, ${'agent'}, ${'m'}, ${cost}, ${when}::timestamptz)
      `);
    }

    for (const [status, when] of [
      ['completed', cur],
      ['completed', cur],
      ['completed', cur],
      ['failed', cur],
      ['completed', base],
      ['failed', base],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
        VALUES (${randomUUID()}, ${project.id}, ${'system'}, ${status}, ${when}::timestamptz)
      `);
    }

    const res = await app.request('/api/admin/overview?window=24h', {
      headers: { authorization: `Bearer ${await signUserToken(admin.id)}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { glance: Record<string, Glance> }).glance;
  }

  it.each(Object.keys(EXPECTED))('%s reports the exact value it did before', (metric) => {
    expect(glance[metric]?.value).toBe(EXPECTED[metric]?.value);
  });

  it.each(Object.keys(EXPECTED))('%s reports the exact deltaPct it did before', (metric) => {
    expect(glance[metric]?.deltaPct).toBe(EXPECTED[metric]?.deltaPct);
  });

  it.each(Object.keys(EXPECTED))('%s reports the exact spark it did before', (metric) => {
    expectSparkPlacedOnce(glance[metric]?.spark ?? [], EXPECTED[metric]?.spark as number);
  });
});
