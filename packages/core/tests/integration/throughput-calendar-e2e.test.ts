import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

/**
 * ISS-1149 — the daily shipped series is dense over the calendar, against real SQL.
 *
 * The defect only shows in a week holding a zero day, so the fixture plants one on each side of a
 * shipping day, a closure one millisecond before the window's first midnight and one exactly on it,
 * a project that shipped nothing at all, and one outside the caller's scope. A week in which every
 * day shipped could not have failed against the sparse query this replaced.
 */

type ShippedPerDay = typeof import('../../src/pipeline/throughput-series.js').shippedPerDay;

const DAY_MS = 86_400_000;
const DAYS = 7;

function utcMidnight(d: Date, daysBack: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - daysBack * DAY_MS,
  );
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('ISS-1149 · shippedPerDay is one calendar window', () => {
  let harness: TestDatabase;
  let shippedPerDay: ShippedPerDay;
  const asOf = new Date();
  const ids = { shipping: '', idle: '', foreign: '' };

  async function plant(projectId: string, seq: number, to: string, at: Date) {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq}, 'shipped', 'open', 'medium', ${ownerId})
    `);
    await harness.db.execute(sql`
      INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${randomUUID()}, ${issueId}, 'user', ${ownerId}, 'issue.statusChanged',
              ${JSON.stringify({ from: 'testing', to })}::jsonb, ${at.toISOString()}::timestamptz)
    `);
  }
  let ownerId = '';

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
    ({ shippedPerDay } = await import('../../src/pipeline/throughput-series.js'));

    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    ids.shipping = (await createTestProject(harness.db, owner.id)).id;
    ids.idle = (await createTestProject(harness.db, owner.id)).id;
    ids.foreign = (await createTestProject(harness.db, owner.id)).id;

    const first = utcMidnight(asOf, DAYS - 1);
    await plant(ids.shipping, 1, 'closed', new Date(first.getTime() - 1));
    await plant(ids.shipping, 2, 'closed', first);
    await plant(
      ids.shipping,
      3,
      'released',
      new Date(utcMidnight(asOf, 2).getTime() + 12 * 3_600_000),
    );
    await plant(
      ids.shipping,
      4,
      'awaiting_release',
      new Date(utcMidnight(asOf, 2).getTime() + 13 * 3_600_000),
    );
    await plant(
      ids.shipping,
      5,
      'in_progress',
      new Date(utcMidnight(asOf, 1).getTime() + 3_600_000),
    );
    await plant(ids.shipping, 6, 'closed', utcMidnight(asOf, 0));
    await plant(ids.foreign, 7, 'closed', utcMidnight(asOf, 1));
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const calendar = () =>
    Array.from({ length: DAYS }, (_, i) => ymd(utcMidnight(asOf, DAYS - 1 - i)));

  it('returns one row per consecutive UTC date ending today, for every project in scope', async () => {
    const rows = await shippedPerDay([ids.shipping, ids.idle], DAYS, asOf);
    for (const projectId of [ids.shipping, ids.idle]) {
      expect(rows.filter((r) => r.projectId === projectId).map((r) => r.date)).toEqual(calendar());
    }
    expect(rows).toHaveLength(2 * DAYS);
  });

  it('carries a day with nothing shipped as a zero row at its own date', async () => {
    const rows = await shippedPerDay([ids.shipping], DAYS, asOf);
    const byDate = new Map(rows.map((r) => [r.date, r.count]));
    expect(byDate.get(ymd(utcMidnight(asOf, 1)))).toBe(0);
    expect(byDate.get(ymd(utcMidnight(asOf, 3)))).toBe(0);
    expect(rows.map((r) => r.count)).toEqual([1, 0, 0, 0, 2, 0, 1]);
  });

  it('counts a closure on the first midnight and none a millisecond before it', async () => {
    const rows = await shippedPerDay([ids.shipping], DAYS, asOf);
    expect(rows[0]).toEqual({ projectId: ids.shipping, date: calendar()[0], count: 1 });
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(4);
  });

  it('answers a project that shipped nothing with seven zeros rather than no rows', async () => {
    const rows = await shippedPerDay([ids.idle], DAYS, asOf);
    expect(rows.map((r) => r.count)).toEqual(Array(DAYS).fill(0));
  });

  it('counts nothing from a project outside the scope it was given', async () => {
    const rows = await shippedPerDay([ids.shipping, ids.idle], DAYS, asOf);
    expect(rows.some((r) => r.projectId === ids.foreign)).toBe(false);
  });

  it('answers an empty scope with no rows', async () => {
    expect(await shippedPerDay([], DAYS, asOf)).toEqual([]);
  });
});
