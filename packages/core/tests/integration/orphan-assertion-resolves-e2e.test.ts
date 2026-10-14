/**
 * ISS-1168 r2 — an orphan-assertion notice resolves when its cause ends.
 *
 * Nothing resolved `issue:<id>:run-assertion-orphaned`, so the notice kept firing after the issue
 * was put on hold: a notice that says "work is in progress with no run behind it" about an issue
 * that asserts no work. Real Postgres, because the cause is a predicate over `issues`, `jobs`,
 * `pipeline_runs` and a run session's issue group, and what resolves is a row in `notifications`.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  detectOrphanedRunAssertions: typeof import('../../src/pipeline/issue-run-invariant.js').detectOrphanedRunAssertions;
  orphanedAssertionResolutionKey: typeof import('../../src/pipeline/issue-run-invariant.js').orphanedAssertionResolutionKey;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  registerTransitionNotifications: typeof import('../../src/notifications/notify-transitions.js').registerTransitionNotifications;
  HooksBus: typeof import('../../src/pipeline/hooks.js').HooksBus;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const invariant = await import('../../src/pipeline/issue-run-invariant.js');
  const runSession = await import('../../src/devices/run-session.js');
  const transitions = await import('../../src/notifications/notify-transitions.js');
  const hooks = await import('../../src/pipeline/hooks.js');
  mods = {
    detectOrphanedRunAssertions: invariant.detectOrphanedRunAssertions,
    orphanedAssertionResolutionKey: invariant.orphanedAssertionResolutionKey,
    openRunSession: runSession.openRunSession,
    registerTransitionNotifications: transitions.registerTransitionNotifications,
    HooksBus: hooks.HooksBus,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const PAST_GRACE = 30 * 60 * 1000;

/** An issue at `status`, last written long enough ago that the sweep names it, and the sweep run once. */
async function orphanNamed(seq = 1, status = 'in_progress') {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const written = new Date(Date.now() - PAST_GRACE).toISOString();
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, created_by_id, iss_seq, title, status, created_at, updated_at)
    VALUES (${project.id}, ${user.id}, ${seq}, ${`issue ${seq}`}, ${status}, ${written}, ${written})
    RETURNING id
  `)) as unknown as { id: string }[];
  const issueId = rows[0]?.id as string;
  const named = await mods.detectOrphanedRunAssertions();
  expect(named.reported, 'the sweep names the orphan before anything resolves it').toBe(1);
  return { user, project, issueId };
}

async function noticeOf(issueId: string): Promise<{ resolvedAt: Date | null; state: string }> {
  const rows = (await harness.db.execute(sql`
    SELECT resolved_at AS "resolvedAt", state
      FROM notifications
     WHERE resolution_key = ${mods.orphanedAssertionResolutionKey(issueId)}
  `)) as unknown as { resolvedAt: Date | null; state: string }[];
  expect(rows, 'exactly one orphan notice exists for the issue').toHaveLength(1);
  return rows[0] as { resolvedAt: Date | null; state: string };
}

describe('an orphan notice whose cause has ended', () => {
  it('stays unresolved while the issue still asserts work with no run behind it', async () => {
    const { issueId } = await orphanNamed();

    const again = await mods.detectOrphanedRunAssertions();

    expect(again.resolved).toBe(0);
    expect((await noticeOf(issueId)).resolvedAt).toBeNull();
  });

  it('resolves on the next sweep once the issue is put on hold', async () => {
    const { issueId } = await orphanNamed();
    await harness.db.execute(sql`UPDATE issues SET status = 'on_hold' WHERE id = ${issueId}`);

    const swept = await mods.detectOrphanedRunAssertions();

    expect(swept.resolved, 'the issue asserts no work now, so the notice about it is over').toBe(1);
    const notice = await noticeOf(issueId);
    expect(notice.resolvedAt).not.toBeNull();
    expect(notice.state).toBe('resolved');
  });

  it('resolves at the transition itself, not a sweep later', async () => {
    const { user, project, issueId } = await orphanNamed();
    const bus = new mods.HooksBus();
    mods.registerTransitionNotifications(bus);
    await harness.db.execute(sql`UPDATE issues SET status = 'on_hold' WHERE id = ${issueId}`);

    await bus.emit('transition', {
      issueId,
      projectId: project.id,
      actor: { type: 'user', id: user.id, agency: 'human' },
      from: 'in_progress',
      to: 'on_hold',
      reopenCount: 0,
    });

    expect((await noticeOf(issueId)).resolvedAt, 'resolved before any sweep ran').not.toBeNull();
  });

  it('is not resolved by a transition to a status that still asserts work', async () => {
    const { user, project, issueId } = await orphanNamed();
    const bus = new mods.HooksBus();
    mods.registerTransitionNotifications(bus);

    await bus.emit('transition', {
      issueId,
      projectId: project.id,
      actor: { type: 'user', id: user.id, agency: 'human' },
      from: 'in_progress',
      to: 'testing',
      reopenCount: 0,
    });

    expect((await noticeOf(issueId)).resolvedAt).toBeNull();
  });

  it('resolves once a run session owns the assertion again', async () => {
    const { user, project, issueId } = await orphanNamed(7);
    const device = await createTestDevice(harness.db, user.id);
    await bindTestRunner(harness.db, { projectId: project.id, deviceId: device.id });
    await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-7'],
      name: 'run-a',
    });

    const swept = await mods.detectOrphanedRunAssertions();

    expect(swept.resolved).toBe(1);
    expect((await noticeOf(issueId)).resolvedAt).not.toBeNull();
  });

  it('is not resolved by a write to the issue that only moves its clock', async () => {
    const { issueId } = await orphanNamed();
    await harness.db.execute(sql`UPDATE issues SET updated_at = now() WHERE id = ${issueId}`);

    const swept = await mods.detectOrphanedRunAssertions();

    expect(swept.detected, 'inside the grace again, so the detector does not see it').toBe(0);
    expect(swept.resolved, 'but the cause has not ended, and a clock move is not a cause').toBe(0);
    expect((await noticeOf(issueId)).resolvedAt).toBeNull();
  });
});
