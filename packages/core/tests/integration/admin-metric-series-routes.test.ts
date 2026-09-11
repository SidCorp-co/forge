// ISS-975 — GET /api/admin/metrics/:metric/timeseries, against real Postgres so
// the moved bucketed SQL and the equalities against /overview are exercised
// rather than asserted over mocks.

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

const METRIC_NAMES = [
  'leadTimeMinutes',
  'interventionsPerClosed',
  'costPerClosedUsd',
  'successRatePct',
  'signupsWindow',
] as const;

type SeriesBody = {
  metric: string;
  window: string;
  value: number | null;
  deltaPct: number | null;
  points: Array<{ bucketStart: string; value: number | null }>;
};
type Glance = { value: number | null; deltaPct: number | null; spark: number[] };

async function seedOneWindow(harness: TestDatabase, ownerEmail: string) {
  const owner = await createTestUser(harness.db, { email: ownerEmail });
  const project = await createTestProject(harness.db, owner.id);
  const t0 = Date.now();
  const at = (hoursAgo: number) => new Date(t0 - hoursAgo * 3_600_000).toISOString();

  for (const [hoursAgo, status] of [
    [3, 'completed'],
    [3, 'completed'],
    [3, 'failed'],
    [30, 'completed'],
    [30, 'failed'],
  ] as const) {
    await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
        VALUES (${randomUUID()}, ${project.id}, ${'system'}, ${status}, ${at(hoursAgo)}::timestamptz)
      `);
  }
  for (const [i, hoursAgo] of [3, 3, 30].entries()) {
    await harness.db.execute(sql`
        INSERT INTO users (id, email, created_at)
        VALUES (${randomUUID()}, ${`sig-${i}@test.forge.local`}, ${at(hoursAgo)}::timestamptz)
      `);
  }
  await harness.db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at)
      VALUES (${randomUUID()}, ${project.id}, ${'agent'}, ${'m'}, ${8}, ${at(3)}::timestamptz)
    `);
}

describe('admin metric series route (ISS-975)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let mintPat: typeof import('../../src/auth/pat.js').mintPat;

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

    const { adminMetricSeriesRoutes } = await import('../../src/admin/metric-series-routes.js');
    const { adminAggregateRoutes } = await import('../../src/admin/aggregate-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
    mintPat = (await import('../../src/auth/pat.js')).mintPat;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/admin', adminMetricSeriesRoutes);
    app.route('/api/admin', adminAggregateRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function verifiedUser(email: string) {
    const user = await createTestUser(harness.db, { email });
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  async function adminToken() {
    const admin = await verifiedUser(ADMIN_EMAIL);
    return signUserToken(admin.id);
  }

  const get = (path: string, token?: string) =>
    app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

  describe('the fence', () => {
    it('401s a request with no Authorization header', async () => {
      const res = await get('/api/admin/metrics/leadTimeMinutes/timeseries?window=7d');
      expect(res.status).toBe(401);
    });

    it('403s ADMIN_ONLY for a verified non-admin user', async () => {
      const user = await verifiedUser('nobody@test.forge.local');
      const res = await get(
        '/api/admin/metrics/leadTimeMinutes/timeseries?window=7d',
        await signUserToken(user.id),
      );

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('ADMIN_ONLY');
    });

    it('403s EMAIL_NOT_VERIFIED for an allow-listed admin who has not verified', async () => {
      const admin = await createTestUser(harness.db, { email: ADMIN_EMAIL });
      const res = await get(
        '/api/admin/metrics/leadTimeMinutes/timeseries?window=7d',
        await signUserToken(admin.id),
      );

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('EMAIL_NOT_VERIFIED');
    });

    // cm:guard `/api/admin` is deliberately absent from `auth/pat-permissions.ts`, so a PAT is refused inside requireAuth before this handler runs — even one owned by an allow-listed, verified admin. This case is what keeps that true if the permission menu is later edited: listing the prefix there would widen every PAT onto the whole cross-tenant console (ISS-975).
    it('403s PAT_NOT_PERMITTED for a valid PAT owned by a verified allow-listed admin', async () => {
      const admin = await verifiedUser(ADMIN_EMAIL);
      const { plaintext } = await mintPat({ userId: admin.id, name: 'admin-pat' });

      const res = await get('/api/admin/metrics/leadTimeMinutes/timeseries?window=7d', plaintext);

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('PAT_NOT_PERMITTED');
    });
  });

  describe('the arguments', () => {
    it('400s BAD_REQUEST for a metric outside the glance names', async () => {
      const res = await get('/api/admin/metrics/notAMetric/timeseries', await adminToken());

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('BAD_REQUEST');
    });

    it('400s BAD_REQUEST for a window outside 24h|7d|30d', async () => {
      const res = await get(
        '/api/admin/metrics/leadTimeMinutes/timeseries?window=90d',
        await adminToken(),
      );

      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe('BAD_REQUEST');
    });

    it('defaults to the 24h window when none is given, as /overview does', async () => {
      const res = await get('/api/admin/metrics/leadTimeMinutes/timeseries', await adminToken());

      expect(res.status).toBe(200);
      const body = (await res.json()) as SeriesBody;
      expect(body.window).toBe('24h');
      expect(body.points).toHaveLength(48);
    });
  });

  describe('the series', () => {
    it.each(METRIC_NAMES)('200s at %s', async (metric) => {
      const res = await get(
        `/api/admin/metrics/${metric}/timeseries?window=7d`,
        await adminToken(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as SeriesBody;
      expect(body.metric).toBe(metric);
    });

    it.each([
      ['24h', 48, 3_600_000],
      ['7d', 14, 86_400_000],
      ['30d', 60, 86_400_000],
    ] as const)(
      'at %s lays %i dense points, oldest first, one bucket apart',
      async (window, points, stepMs) => {
        const res = await get(
          `/api/admin/metrics/signupsWindow/timeseries?window=${window}`,
          await adminToken(),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as SeriesBody;
        expect(body.points).toHaveLength(points);

        const starts = body.points.map((p) => Date.parse(p.bucketStart));
        for (let i = 1; i < starts.length; i++) {
          expect((starts[i] as number) - (starts[i - 1] as number)).toBe(stepMs);
        }
      },
    );
  });

  // cm:guard the three equalities are judged on ONE seeding and one window: both surfaces read live `now()`, so seeding between the two requests would move the boundary under the second and the comparison would be of two different spans.
  describe('against GET /overview, on one seeding', () => {
    it.each(METRIC_NAMES)(
      '%s reports the same value, deltaPct and spark the glance does',
      async (metric) => {
        await seedOneWindow(harness, 'series-owner@test.forge.local');
        const token = await adminToken();

        const seriesRes = await get(`/api/admin/metrics/${metric}/timeseries?window=24h`, token);
        const overviewRes = await get('/api/admin/overview?window=24h', token);
        expect(seriesRes.status).toBe(200);
        expect(overviewRes.status).toBe(200);

        const series = (await seriesRes.json()) as SeriesBody;
        const { glance } = (await overviewRes.json()) as { glance: Record<string, Glance> };
        const tile = glance[metric] as Glance;

        expect(series.value).toBe(tile.value);
        expect(series.deltaPct).toBe(tile.deltaPct);
        expect(series.points.slice(-24).map((p) => p.value ?? 0)).toEqual(tile.spark);
      },
    );
  });

  describe('a bucket with nothing in it', () => {
    it('carries 0 for a count metric and null for a ratio metric', async () => {
      const token = await adminToken();
      // cm:why the admin this case just minted carries `created_at = now()`, which is a REAL signup inside the window — pushed clear of the 48h span so "no rows" means no rows.
      await harness.db.execute(sql`UPDATE users SET created_at = now() - interval '200 hours'`);

      const [countRes, ratioRes] = await Promise.all([
        get('/api/admin/metrics/signupsWindow/timeseries?window=24h', token),
        get('/api/admin/metrics/successRatePct/timeseries?window=24h', token),
      ]);

      const counts = (await countRes.json()) as SeriesBody;
      const ratios = (await ratioRes.json()) as SeriesBody;

      expect(counts.points.every((p) => p.value === 0)).toBe(true);
      expect(ratios.points.every((p) => p.value === null)).toBe(true);
    });
  });
});
