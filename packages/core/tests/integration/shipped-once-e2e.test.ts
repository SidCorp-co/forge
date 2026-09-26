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
 * ISS-1270 — an issue counts once, on the UTC day of its first shipped transition, on every surface
 * that counts shipped issues.
 *
 * Every planted issue makes more than one shipped transition, because a fixture where each issue
 * makes one cannot tell a count of issues from a count of transitions. Each issue is created exactly
 * one day before its first shipped transition, so every per-issue cycle time is exactly 1.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAYS = 7;

const asOf = new Date();
const midnight = (daysBack: number) =>
  new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()) - daysBack * DAY_MS,
  );
const at = (daysBack: number, hours: number, minutes = 0) =>
  new Date(midnight(daysBack).getTime() + hours * HOUR_MS + minutes * 60_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Each issue's transitions, and which UTC day (days back from today) it must count on. */
const PLANTED = {
  sameDay: {
    moves: [
      ['testing', 'awaiting_release', at(2, 10)],
      ['awaiting_release', 'closed', at(2, 10, 5)],
    ],
    countsOn: 2,
  },
  twoDaysApart: {
    moves: [
      ['testing', 'awaiting_release', at(4, 9)],
      ['awaiting_release', 'closed', midnight(0)],
    ],
    countsOn: 4,
  },
  reopened: {
    moves: [
      ['testing', 'closed', at(5, 8)],
      ['closed', 'open', at(5, 12)],
      ['testing', 'closed', at(3, 8)],
    ],
    countsOn: 5,
  },
  shippedBeforeWindow: {
    moves: [
      ['testing', 'closed', at(10, 8)],
      ['closed', 'open', at(9, 8)],
      ['testing', 'closed', at(1, 10)],
    ],
    countsOn: 10,
  },
  sameInstant: {
    moves: [
      ['testing', 'awaiting_release', at(1, 11)],
      ['awaiting_release', 'closed', at(1, 11)],
    ],
    countsOn: 1,
  },
} as const satisfies Record<
  string,
  { moves: ReadonlyArray<readonly [string, string, Date]>; countsOn: number }
>;

/** The seven-day card, oldest day first: one issue on each of days 5, 4, 2 and 1 back. */
const CARD = [0, 1, 1, 0, 1, 1, 0];

describe('ISS-1270 · a shipped issue counts once, on its first shipped day', () => {
  let harness: TestDatabase;
  let projectId = '';
  let ownerId = '';
  const issueIds: Record<keyof typeof PLANTED, string> = {
    sameDay: '',
    twoDaysApart: '',
    reopened: '',
    shippedBeforeWindow: '',
    sameInstant: '',
  };

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

    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;

    const labelId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color)
      VALUES (${labelId}, ${projectId}, 'intervention', '#000000')
    `);

    let seq = 0;
    for (const [key, spec] of Object.entries(PLANTED) as Array<
      [keyof typeof PLANTED, (typeof PLANTED)[keyof typeof PLANTED]]
    >) {
      seq += 1;
      const issueId = randomUUID();
      issueIds[key] = issueId;
      const createdAt = new Date(spec.moves[0][2].getTime() - DAY_MS);
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, created_at)
        VALUES (${issueId}, ${projectId}, ${seq}, ${key}, 'open', 'medium', ${ownerId},
                ${createdAt.toISOString()}::timestamptz)
      `);
      for (const [from, to, when] of spec.moves) {
        await harness.db.execute(sql`
          INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
          VALUES (${randomUUID()}, ${issueId}, 'user', ${ownerId}, 'issue.statusChanged',
                  ${JSON.stringify({ from, to })}::jsonb, ${when.toISOString()}::timestamptz)
        `);
      }
      if (key === 'sameDay' || key === 'sameInstant') {
        await harness.db.execute(sql`
          INSERT INTO issue_labels (issue_id, label_id) VALUES (${issueId}, ${labelId})
        `);
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  describe('the Insights Throughput card (shippedPerDay)', () => {
    const series = async () => {
      const { shippedPerDay } = await import('../../src/pipeline/throughput-series.js');
      return shippedPerDay([projectId], DAYS, asOf);
    };
    const countOn = async (daysBack: number) =>
      (await series()).find((r) => r.date === ymd(midnight(daysBack)))?.count;

    it('counts an issue that went testing → awaiting_release → closed in one day once on that day', async () => {
      expect(await countOn(PLANTED.sameDay.countsOn)).toBe(1);
    });

    it('counts an issue shipped to awaiting_release and closed days later on the first day only', async () => {
      expect(await countOn(PLANTED.twoDaysApart.countsOn)).toBe(1);
      expect(await countOn(0)).toBe(0);
    });

    it('counts a closed, reopened and reclosed issue once, on the day it first closed', async () => {
      expect(await countOn(PLANTED.reopened.countsOn)).toBe(1);
      expect(await countOn(3)).toBe(0);
    });

    it('counts an issue that first shipped before the window as zero, though it reshipped inside it', async () => {
      expect(await countOn(1)).toBe(1);
    });

    it('counts two shipped transitions at the same instant as one issue', async () => {
      expect(await countOn(PLANTED.sameInstant.countsOn)).toBe(1);
    });

    it('totals the distinct issues whose first shipped day is in the window, on a dense seven-day calendar', async () => {
      const rows = await series();
      expect(rows.map((r) => r.date)).toEqual(
        Array.from({ length: DAYS }, (_, i) => ymd(midnight(DAYS - 1 - i))),
      );
      expect(rows.map((r) => r.count)).toEqual(CARD);
      expect(rows.reduce((a, r) => a + r.count, 0)).toBe(4);
    });
  });
});
