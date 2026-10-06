/**
 * ISS-1324: alert A6 (`admin/gate-alert.ts`) through `runAlertSweep` against real
 * Postgres. A box's heartbeat-carried gate report reaches the admins as an
 * `ops_alert`, and the alert clears once the box stops failing open.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  runAlertSweep: typeof import('../../src/admin/alert-sweeper.js').runAlertSweep;
};

let harness: TestDatabase;

const ADMIN_EMAIL = 'admin@test.forge.local';

let clockMs = Date.parse('2026-01-01T00:00:00Z');
function nextNow(): Date {
  clockMs += 10 * 60_000;
  return new Date(clockMs);
}

async function seedAdmin() {
  const admin = await createTestUser(harness.db, { email: ADMIN_EMAIL });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${admin.id}`);
  return admin;
}

/**
 * A box whose last heartbeat, heard at `heardAt`, carried the gate condition the
 * daemon derives (`daemon/degraded.rs:condition`) under `verdict`.
 */
async function seedGateReport(
  verdict: 'failing_open' | 'marked' | 'clear',
  heardAt: Date,
  deviceId?: string,
): Promise<string> {
  const id =
    deviceId ??
    (
      await createTestDevice(harness.db, (await createTestUser(harness.db)).id, {
        name: 'sid-xeon-1',
      })
    ).id;
  const report = {
    degraded: {
      verdict,
      count: 409,
      trimmed: true,
      firstAt: heardAt.getTime() - 9 * 86_400_000,
      lastAt: heardAt.getTime() - 240_000,
      windowMs: 9 * 86_400_000,
      perDay: 45,
      sinceLastMs: 240_000,
      last: { detail: 'the daemon did not answer within the bound', source: 'hook' },
      byReason: [{ reason: 'the daemon did not answer within the bound', count: 409 }],
    },
    receivedAt: heardAt.toISOString(),
  };
  await harness.db.execute(
    sql`UPDATE devices SET gate_report = ${JSON.stringify(report)}::jsonb WHERE id = ${id}`,
  );
  return id;
}

type OpsAlertRow = {
  user_id: string;
  severity: string | null;
  read: boolean;
  resolved_at: Date | null;
  title: string;
  body: string | null;
};

async function opsAlertRows(): Promise<OpsAlertRow[]> {
  const rows = await harness.db.execute<OpsAlertRow>(sql`
    SELECT d.user_id, n.severity, (d.read_at IS NOT NULL) AS read, n.resolved_at, n.title, n.body
      FROM notifications n
      JOIN notification_delivery_members m ON m.notification_id = n.id
      JOIN notification_deliveries d ON d.id = m.delivery_id AND d.resolved_notice = false
     WHERE n.type = 'ops_alert' AND n.resolution_key = 'ops-alert:A6'
  `);
  return rows as unknown as OpsAlertRow[];
}

describe('A6 through runAlertSweep (ISS-1324)', () => {
  let mods: Mods;

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
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    mods = (await import('../../src/admin/alert-sweeper.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('tells admins when a box reports its gate failing open, and resolves once it clears', async () => {
    const admin = await seedAdmin();
    const firing = nextNow();
    const deviceId = await seedGateReport('failing_open', firing);

    const result = await mods.runAlertSweep(firing);
    expect(result.notified).toBe(1);
    const [row, ...rest] = await opsAlertRows();
    expect(rest).toHaveLength(0);
    expect(row?.user_id).toBe(admin.id);
    expect(row?.severity).toBe('warning');
    expect(row?.read).toBe(false);
    expect(row?.resolved_at).toBeNull();
    expect(row?.title).toContain('Declaration gate failing open');
    expect(row?.body).toBe(
      'sid-xeon-1: at least 409 dispatch(es) admitted without the gate deciding, 45/day over 9d',
    );

    const cleared = nextNow();
    await seedGateReport('marked', cleared, deviceId);
    const after = await mods.runAlertSweep(cleared);
    expect(after.resolved).toBeGreaterThan(0);
    expect((await opsAlertRows()).every((r) => r.resolved_at !== null)).toBe(true);
  });

  it('tells nobody about a failing-open report the box stopped renewing', async () => {
    await seedAdmin();
    const heard = nextNow();
    await seedGateReport('failing_open', heard);

    nextNow();
    const twentyMinutesLater = nextNow();
    await mods.runAlertSweep(twentyMinutesLater);
    expect(await opsAlertRows()).toHaveLength(0);
  });
});
