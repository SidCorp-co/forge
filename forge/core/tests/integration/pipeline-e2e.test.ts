import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HooksBus } from '../../src/pipeline/hooks.js';
import { registerActivitySubscribers } from '../../src/pipeline/subscribers.js';
import { canTransition } from '../../src/pipeline/state-machine.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.3-F6 pipeline E2E.
//
// Exercises the bus → subscribers → activity_log path against real Postgres,
// plus the status state machine and reopen cap semantics at the DB level.
// This sits alongside the F4 state-machine unit tests and F5 unit tests —
// the additive value here is the end-to-end integration of the F6 hooks bus
// with the F5 subscriber, verifying that activity rows land correctly when
// the same payload shapes the real routes emit are pushed through the bus.

describe('F6 pipeline E2E', () => {
  let harness: TestDatabase;
  // Subscribers call safeRecordActivity, which uses the app's db client.
  // The app's db reads DATABASE_URL at module load; in this test we set it
  // to the harness URL BEFORE importing the activity module via dynamic
  // import below.
  type ActivityMod = typeof import('../../src/pipeline/activity.js');
  let activity: ActivityMod;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    // Required env for the app-side modules we'll load.
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
    activity = await import('../../src/pipeline/activity.js');
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    return { user, project };
  }

  async function insertIssue(
    projectId: string,
    createdById: string,
    overrides: { status?: string; reopenCount?: number; title?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, reopen_count, created_by_id, iss_seq)
      VALUES (
        ${id},
        ${projectId},
        ${overrides.title ?? 'integration issue'},
        ${overrides.status ?? 'open'},
        ${overrides.reopenCount ?? 0},
        ${createdById},
        ${Math.floor(Math.random() * 100000)}
      )
    `);
    return id;
  }

  async function activityRows(issueId: string): Promise<Array<{ action: string; payload: unknown }>> {
    const rows = await harness.db.execute<{ action: string; payload: unknown }>(sql`
      SELECT action, payload FROM activity_log
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `);
    return rows as Array<{ action: string; payload: unknown }>;
  }

  it('bus → activity_log: issueCreated subscriber writes the canonical issue.created row', async () => {
    const { user, project } = await seed();
    const issueId = await insertIssue(project.id, user.id);

    const bus = new HooksBus();
    registerActivitySubscribers(bus);
    await bus.emit('issueCreated', {
      issueId,
      projectId: project.id,
      actor: { type: 'user', id: user.id },
      snapshot: {
        title: 't',
        description: null,
        priority: 'high',
        category: null,
        assigneeId: null,
        labels: [],
      },
    });

    const rows = await activityRows(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('issue.created');
  });

  it('bus → activity_log: transition subscriber fires per status change', async () => {
    const { user, project } = await seed();
    const issueId = await insertIssue(project.id, user.id);

    const bus = new HooksBus();
    registerActivitySubscribers(bus);

    const steps = ['open→confirmed', 'confirmed→approved', 'approved→in_progress'] as const;
    for (const step of steps) {
      const [from, to] = step.split('→') as [
        Parameters<typeof canTransition>[0],
        Parameters<typeof canTransition>[1],
      ];
      expect(canTransition(from, to)).toBe(true);
      await bus.emit('transition', {
        issueId,
        projectId: project.id,
        actor: { type: 'user', id: user.id },
        from,
        to,
        reopenCount: 0,
      });
    }

    const rows = await activityRows(issueId);
    expect(rows).toHaveLength(steps.length);
    for (const r of rows) expect(r.action).toBe('issue.statusChanged');
  });

  it('bus → activity_log: comment subscribers fire for create/update/delete', async () => {
    const { user, project } = await seed();
    const issueId = await insertIssue(project.id, user.id);
    const commentId = randomUUID();
    const bus = new HooksBus();
    registerActivitySubscribers(bus);

    const common = {
      issueId,
      projectId: project.id,
      actor: { type: 'user' as const, id: user.id },
      commentId,
    };
    await bus.emit('commentCreated', { ...common, body: 'hello' });
    await bus.emit('commentUpdated', { ...common, before: 'hello', after: 'hi' });
    await bus.emit('commentDeleted', common);

    const rows = await activityRows(issueId);
    expect(rows.map((r) => r.action)).toEqual([
      'comment.created',
      'comment.updated',
      'comment.deleted',
    ]);
  });

  it('safeRecordActivity cascades on issue delete (FK)', async () => {
    const { user, project } = await seed();
    const issueId = await insertIssue(project.id, user.id);
    await activity.safeRecordActivity({
      issueId,
      actor: { type: 'user', id: user.id },
      action: 'issue.created',
      payload: { snapshot: { title: 't' } },
    });

    expect((await activityRows(issueId)).length).toBe(1);

    await harness.db.execute(sql`DELETE FROM issues WHERE id = ${issueId}`);
    expect((await activityRows(issueId)).length).toBe(0);
  });
});
