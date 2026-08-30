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
};

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
    opts: {
      status?: string;
      mergedAgoMs?: number | null;
      autonomous?: boolean;
      updatedAgoMs?: number;
    } = {},
  ) {
    const owner = await createTestUser(harness.db);
    const org = await seedOrg(harness.db, owner.id);
    const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
    if (opts.autonomous) {
      await harness.db.execute(
        sql`UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { mode: 'autonomous' } })}::jsonb WHERE id = ${project.id}`,
      );
    }

    // cm:why two distinct routes to admin — explicit project_members admin AND the org owner seedOrg registers — because projectAdminUserIds unions both and a regression could drop either
    const projAdmin = await createTestUser(harness.db);
    await createTestProjectMember(harness.db, {
      userId: projAdmin.id,
      projectId: project.id,
      role: 'admin',
    });

    // cm:why a plain member is seeded on purpose: the alarm must reach only people who can actually unpark the issue
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
    if (opts.updatedAgoMs !== undefined) {
      const updatedAt = new Date(Date.now() - opts.updatedAgoMs).toISOString();
      await harness.db.execute(
        sql`UPDATE issues SET updated_at = ${updatedAt} WHERE id = ${issueId}`,
      );
    }
    return { issueId, projectId: project.id, owner, projAdmin, plain };
  }

  async function notifRows(issueId: string) {
    const r = await harness.db.execute(sql`
      SELECT user_id, type, resolution_key, read FROM notifications WHERE issue_id = ${issueId}
    `);
    return r as unknown as {
      user_id: string;
      type: string;
      resolution_key: string;
      read: boolean;
    }[];
  }

  it('surfaces an issue parked at waiting whose code already merged', async () => {
    const s = await seed();
    const res = await mods.detectStrandedIssues();
    expect(res.detected).toBe(1);

    const rows = await notifRows(s.issueId);
    expect(rows.every((r) => r.type === 'issue_stranded')).toBe(true);
    expect(rows.every((r) => r.resolution_key === `issue:${s.issueId}:stranded`)).toBe(true);
  });

  it('reaches every admin who can act, and nobody who cannot', async () => {
    const s = await seed();
    await mods.detectStrandedIssues();
    const notified = new Set((await notifRows(s.issueId)).map((r) => r.user_id));
    expect(notified.has(s.owner.id)).toBe(true);
    expect(notified.has(s.projAdmin.id)).toBe(true);
    expect(notified.has(s.plain.id)).toBe(false);
  });

  // cm:guard this is the pass's load-bearing test — the sweep runs every tick, so a detector that re-notifies on each pass is worse than none: the bell fills with duplicates and stops being read at all
  it('notifies once and then stays quiet while the alarm is unread', async () => {
    const s = await seed();
    const first = await mods.detectStrandedIssues();
    expect(first.notified).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      const again = await mods.detectStrandedIssues();
      expect(again.detected).toBe(1);
      expect(again.notified).toBe(0);
    }
    expect((await notifRows(s.issueId)).length).toBe(first.notified);
  });

  it('re-notifies once the human has read (and thus dismissed) the previous alarm', async () => {
    const s = await seed();
    const first = await mods.detectStrandedIssues();
    await harness.db.execute(
      sql`UPDATE notifications SET read = true WHERE issue_id = ${s.issueId}`,
    );
    const second = await mods.detectStrandedIssues();
    expect(second.notified).toBe(first.notified);
  });

  it('stays silent inside the grace window', async () => {
    await seed({ mergedAgoMs: mods.STRANDED_GRACE_MS - HOUR });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0, notified: 0 });
  });

  it('stays silent for a waiting issue whose code never merged', async () => {
    await seed({ mergedAgoMs: null });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0, notified: 0 });
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
    expect((await notifRows(theirs.issueId)).length).toBe(0);
  });

  // cm:why ISS-886 — on autonomous the park itself is the signal: no next step notices it and `answer-resume` restarts `needs_info` only, so a `waiting` issue stops dead until a human acts. kinetrak ISS-4's split had sat 11 days on 2026-08-30 with nobody told.
  it('surfaces an UNMERGED autonomous park, which on a staged project it ignores', async () => {
    const auto = await seed({ mergedAgoMs: null, autonomous: true, updatedAgoMs: 48 * HOUR });
    const staged = await seed({ mergedAgoMs: null, updatedAgoMs: 48 * HOUR });

    const res = await mods.detectStrandedIssues();

    expect(res.detected).toBe(1);
    expect((await notifRows(auto.issueId)).length).toBeGreaterThan(0);
    expect((await notifRows(staged.issueId)).length).toBe(0);
  });

  // cm:guard the autonomous arm dates from `updated_at`, and it must still respect the grace window — a park is only stranded once it has outlasted a legitimate merge-verify-close pass, or every fresh question would alarm the owner within the minute.
  it('stays silent inside the grace window on an autonomous project too', async () => {
    await seed({ mergedAgoMs: null, autonomous: true, updatedAgoMs: 1 * HOUR });
    await expect(mods.detectStrandedIssues()).resolves.toMatchObject({ detected: 0 });
  });

  it.each(['needs_info', 'on_hold', 'open'])(
    'stays silent for an aged autonomous issue in status %s — only `waiting` is a silent park',
    async (status) => {
      await seed({ status, mergedAgoMs: null, autonomous: true, updatedAgoMs: 48 * HOUR });
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
