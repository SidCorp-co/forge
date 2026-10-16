/**
 * ISS-762 — `detectStrandedIssues` against real Postgres.
 *
 * The condition is an issue parked at `waiting` whose code already reached the
 * base branch (`merged_at` set). Three real cases sat that way for 7–12 days
 * each, holding a `pipeline_run` slot on a project whose concurrency cap is 2,
 * because the only thing that would ever surface them was someone happening to
 * look.
 *
 * What matters most here is not that it fires — it is that it fires ONCE and
 * stops, since the sweep runs every tick.
 */

import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  detectStrandedIssues: typeof import('../../src/pipeline/stranded-issues.js').detectStrandedIssues;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  STRANDED_GRACE_MS: typeof import('../../src/pipeline/stranded-issues.js').STRANDED_GRACE_MS;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
};

type NotifRow = { user_id: string; type: string; resolution_key: string; read: boolean };

async function readNotifs(harness: TestDatabase, issueId: string): Promise<NotifRow[]> {
  const r = await harness.db.execute(sql`
    SELECT d.user_id, n.type, n.resolution_key, (d.read_at IS NOT NULL) AS read
      FROM notifications n
      JOIN notification_delivery_members m ON m.notification_id = n.id
      JOIN notification_deliveries d ON d.id = m.delivery_id AND d.resolved_notice = false
     WHERE n.issue_id = ${issueId}
  `);
  return r as unknown as NotifRow[];
}

async function patchAlarm(harness: TestDatabase, issueId: string, set: SQL): Promise<void> {
  await harness.db.execute(sql`UPDATE notifications SET ${set} WHERE issue_id = ${issueId}`);
}

/**
 * Run the detector until it actually tells somebody.
 *
 * ISS-1063 — `issue_stranded` declares a pending duration of two evaluations, so the first
 * pass that sees a strand writes a `pending` record and delivers to NOBODY: a park that
 * clears inside two sweeps never reaches a human at all. Promotion is by elapsed time, so
 * a test ages `pending_since` rather than waiting two minutes. What comes back is the pass
 * that announced it, which is what every case below is about.
 */
async function announce(
  harness: TestDatabase,
  detect: Mods['detectStrandedIssues'],
): Promise<{ detected: number; notified: number }> {
  const first = await detect();
  expect(first.notified).toBe(0);
  await harness.db.execute(
    sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
  );
  return detect();
}

/** What an admin opening the bell does — and, since ISS-1063, all it does. */
async function markRead(harness: TestDatabase, issueId: string): Promise<void> {
  await harness.db.execute(sql`
    UPDATE notification_deliveries d SET read_at = now()
    FROM notification_delivery_members m, notifications n
    WHERE m.delivery_id = d.id AND n.id = m.notification_id AND n.issue_id = ${issueId}
  `);
}

describe('detectStrandedIssues E2E (ISS-762)', () => {
  let harness: TestDatabase;
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

    mods = (await import('../../src/pipeline/stranded-issues.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  const HOUR = 60 * 60 * 1000;

  async function seed(
    opts: { status?: string; mergedAgoMs?: number | null; updatedAgoMs?: number } = {},
  ) {
    const owner = await createTestUser(harness.db);
    const org = await seedOrg(harness.db, owner.id);
    const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
    const projAdmin = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: projAdmin.id,
      projectId: project.id,
      role: 'admin',
    });

    const plain = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: plain.id,
      projectId: project.id,
      role: 'member',
    });

    const mergedAgo = opts.mergedAgoMs === undefined ? 48 * HOUR : opts.mergedAgoMs;
    const mergedAt = mergedAgo === null ? null : new Date(Date.now() - mergedAgo).toISOString();
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, iss_seq)
      VALUES (${issueId}, ${project.id}, 'stranded probe', ${opts.status ?? 'waiting'},
              ${owner.id}, ${mergedAt}, 762)
    `);
    const updatedAgo = opts.updatedAgoMs ?? 48 * HOUR;
    const updatedAt = new Date(Date.now() - updatedAgo).toISOString();
    await harness.db.execute(
      sql`UPDATE issues SET updated_at = ${updatedAt} WHERE id = ${issueId}`,
    );
    return { issueId, projectId: project.id, owner, projAdmin, plain };
  }

  it('surfaces an issue parked at waiting whose code already merged', async () => {
    const s = await seed();
    const res = await announce(harness, mods.detectStrandedIssues);
    expect(res.detected).toBe(1);

    const rows = await readNotifs(harness, s.issueId);
    expect(rows.every((r) => r.type === 'issue_stranded')).toBe(true);
    expect(rows.every((r) => r.resolution_key === `issue:${s.issueId}:stranded`)).toBe(true);
  });

  it('reaches every admin who can act, and nobody who cannot', async () => {
    const s = await seed();
    await announce(harness, mods.detectStrandedIssues);
    const notified = new Set((await readNotifs(harness, s.issueId)).map((r) => r.user_id));
    expect(notified.has(s.owner.id)).toBe(true);
    expect(notified.has(s.projAdmin.id)).toBe(true);
    expect(notified.has(s.plain.id)).toBe(false);
  });

  it('notifies once and then stays quiet while the alarm is unread', async () => {
    const s = await seed();
    const first = await announce(harness, mods.detectStrandedIssues);
    expect(first.notified).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      const again = await mods.detectStrandedIssues();
      expect(again.detected).toBe(1);
      expect(again.notified).toBe(0);
    }
    expect((await readNotifs(harness, s.issueId)).length).toBe(first.notified);
  });

  it('stays quiet after a read, because a read is not something the record can see', async () => {
    const s = await seed();
    const first = await announce(harness, mods.detectStrandedIssues);
    expect(first.notified).toBeGreaterThan(0);
    await markRead(harness, s.issueId);

    const second = await mods.detectStrandedIssues();
    expect(second.detected).toBe(1);
    expect(second.notified).toBe(0);
    expect((await readNotifs(harness, s.issueId)).length).toBe(first.notified);
  });

  it('re-notifies a RESOLVED strand that recurred, at once', async () => {
    const s = await seed();
    const first = await announce(harness, mods.detectStrandedIssues);
    expect(first.notified).toBeGreaterThan(0);

    await markRead(harness, s.issueId);
    await patchAlarm(harness, s.issueId, sql`resolved_at = now(), state = 'resolved'`);

    const second = await announce(harness, mods.detectStrandedIssues);
    expect(second.detected).toBe(1);
    expect(second.notified).toBe(first.notified);
  });

  // ISS-1063 — this asserted a 24-hour re-notify window, which is DELETED along with the
  // lookup it bounded: the window existed because the old dedupe keyed on an unread row, so
  // a glance at the bell re-armed the alarm and the 60-second sweep pinged again within the
  // minute. Read state is not on the record any more, and what stops a second telling is the
  // delivery layer. So the assertion inverts: age is now no reason to raise a still-firing
  // strand again, and a pass that reintroduced a `created_at` window would fail here.
  it('does not raise a still-firing strand again however old its record is', async () => {
    const s = await seed();
    const first = await announce(harness, mods.detectStrandedIssues);
    expect(first.notified).toBeGreaterThan(0);

    await markRead(harness, s.issueId);
    await patchAlarm(
      harness,
      s.issueId,
      sql`created_at = now() - interval '30 days', state = 'firing'`,
    );

    const second = await announce(harness, mods.detectStrandedIssues);
    expect(second.detected).toBe(1);
    expect(second.notified).toBe(0);
    expect((await readNotifs(harness, s.issueId)).length).toBe(first.notified);
  });

  it('stays silent inside the grace window', async () => {
    await seed({ updatedAgoMs: mods.STRANDED_GRACE_MS - HOUR });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0, notified: 0 });
  });

  it('surfaces a waiting park whose code never merged', async () => {
    await seed({ mergedAgoMs: null });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 1 });
  });

  it.each(['closed', 'in_progress', 'developed', 'testing', 'reopen'])(
    'stays silent for a merged issue in status %s',
    async (status) => {
      await seed({ status });
      await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0 });
    },
  );

  it('scopes to one project when asked', async () => {
    const mine = await seed();
    const theirs = await seed();
    const res = await mods.detectStrandedIssues(new Date(), { projectId: mine.projectId });
    expect(res.detected).toBe(1);
    expect((await readNotifs(harness, theirs.issueId)).length).toBe(0);
  });

  it('surfaces an unmerged park on every project, whatever legacy config the row carries', async () => {
    const stripped = await seed({ mergedAgoMs: null });
    const legacy = await seed({ mergedAgoMs: null });
    await harness.db.execute(
      sql`UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { mode: 'staged' } })}::jsonb WHERE id = ${legacy.projectId}`,
    );

    const res = await announce(harness, mods.detectStrandedIssues);

    expect(res.detected).toBe(2);
    expect((await readNotifs(harness, stripped.issueId)).length).toBeGreaterThan(0);
    expect((await readNotifs(harness, legacy.issueId)).length).toBeGreaterThan(0);
  });

  it('stays silent inside the grace window too', async () => {
    await seed({ mergedAgoMs: null, updatedAgoMs: 1 * HOUR });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0 });
  });

  it.each(['needs_info', 'on_hold', 'open'])(
    'stays silent for an aged issue in status %s — only `waiting` is a silent park',
    async (status) => {
      await seed({ status, mergedAgoMs: null, updatedAgoMs: 48 * HOUR });
      await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0 });
    },
  );

  it('never moves the issue — waiting is a human park', async () => {
    const s = await seed();
    await mods.detectStrandedIssues();
    const r = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${s.issueId}`,
    )) as unknown as { status: string }[];
    expect(r[0]?.status).toBe('waiting');
  });
});
