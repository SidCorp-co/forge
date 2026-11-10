/**
 * ISS-863 (owner, 2026-11-01, `notify-only-to-act`): a project read 99+ notifications, most of them
 * status moves. A move that asks nothing of its reader rings no bell and stays in activity; a stop on
 * the reader (`needs_info`) rings one; repeats on one item reach the reader as one bell entry, read
 * again as new; and the project's volume by type is readable, the measure the cut is judged by.
 * Against real Postgres.
 *
 * ISS-1192 (FB-603): a log-tier record is activity and reaches no bell; every notice about one
 * requirement or one feedback item is one bell row at its latest title; and a check the Steward
 * makes by rule opens no task for a person, so no "Resolved" row follows it.
 *
 * @direct-test-of packages/core/src/notifications/notify-transitions.ts
 * @direct-test-of packages/core/src/notifications/notify-requirements.ts
 * @direct-test-of packages/core/src/notifications/notify-feedback.ts
 * @direct-test-of packages/core/src/notifications/deliver.ts
 * @direct-test-of packages/core/src/notifications/emit.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';
import { underStrict } from '../helpers/project-controls.js';

const w = { projectId: '', ownerId: '', moverId: '', token: '' };

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  w.ownerId = (await createTestUser({ verified: true })).id;
  w.moverId = (await createTestUser({ verified: true })).id;
  w.projectId = (await createTestProject(w.ownerId)).id;
  w.token = await userToken(w.ownerId);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

let event = 0;
async function moved(issueId: string, from: string, to: string) {
  const { consumerOf } = await import('../../src/outbox/consumers.js');
  const handler = consumerOf('issue.transitioned', 'notify-transitions');
  if (!handler) throw new Error('notify-transitions is not registered');
  event += 1;
  await handler.handle(
    {
      entity: 'issue',
      id: issueId,
      projectId: w.projectId,
      from,
      to,
      actor: { type: 'user', id: w.moverId },
      reason: null,
      at: new Date().toISOString(),
    } as never,
    { eventId: `00000000-0000-4000-8000-${String(event).padStart(12, '0')}` } as never,
  );
}

const bell = (issueId: string) =>
  rows<{ type: string; delivery: string; read_at: string | null }>(sql`
    SELECT n.type, m.delivery_id AS delivery, d.read_at
      FROM notifications n
      JOIN notification_delivery_members m ON m.notification_id = n.id
      JOIN notification_deliveries d ON d.id = m.delivery_id
     WHERE n.issue_id = ${issueId} AND d.user_id = ${w.ownerId}`);

describe('notify only to act (ISS-863)', () => {
  it('rings no bell for a status move that asks nothing of its reader', async () => {
    const issue = await createTestIssue(w.projectId, w.ownerId, 1, {
      status: 'open',
      createdAt: new Date(),
    });
    await moved(issue.id, 'in_progress', 'awaiting_release');
    await moved(issue.id, 'awaiting_release', 'reopen');
    await moved(issue.id, 'awaiting_release', 'closed');
    expect(await bell(issue.id)).toEqual([]);
  });

  it('rings one bell entry for a stop on its reader, however often it repeats', async () => {
    const issue = await createTestIssue(w.projectId, w.ownerId, 2, {
      status: 'open',
      createdAt: new Date(),
    });
    await moved(issue.id, 'in_progress', 'needs_info');
    const first = await bell(issue.id);
    expect(first).toHaveLength(1);
    await rows(
      sql`UPDATE notification_deliveries SET read_at = now() WHERE id = ${first[0]?.delivery}`,
    );
    await moved(issue.id, 'open', 'needs_info');
    const after = await bell(issue.id);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.delivery)).size).toBe(1);
    expect(after[0]?.read_at, 'the repeat is new again on the one entry').toBeNull();
  });

  it("reads the project's volume by type, records and bell entries apart", async () => {
    const got = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/notifications/volume?days=1`,
    );
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.types).toEqual([{ type: 'issue_status_changed', records: 2, deliveries: 1 }]);
    expect(got.body).toMatchObject({ records: 2, deliveries: 1 });
    const bad = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/notifications/volume?days=0`,
    );
    expect(bad.status).toBe(400);
  });
});

/** Every bell row `userId` holds about records whose title names `key`, oldest first. */
const rowsAbout = (userId: string, key: string) =>
  rows<{ delivery: string; title: string; read_at: string | null; resolved_notice: boolean }>(sql`
    SELECT DISTINCT d.id AS delivery, d.title, d.read_at, d.resolved_notice, d.created_at
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${userId} AND n.title LIKE ${`%${key}%`}
     ORDER BY d.created_at`);

const recordsAbout = (key: string) =>
  rows<{ type: string; tier: string }>(sql`
    SELECT type, tier FROM notifications
     WHERE project_id = ${w.projectId} AND title LIKE ${`%${key}%`} ORDER BY created_at`);

async function handle(name: string, consumer: string, payload: Record<string, unknown>) {
  const { consumerOf } = await import('../../src/outbox/consumers.js');
  const handler = consumerOf(name as never, consumer);
  if (!handler) throw new Error(`${consumer} does not consume ${name}`);
  await handler.handle(payload as never, { eventId: randomUUID() } as never);
}

describe('the bell holds only what a person owns (ISS-1192)', () => {
  it('writes a log-tier record for the history and delivers it to nobody', async () => {
    const { emitNotification } = await import('../../src/notifications/index.js');
    const out = await emitNotification({
      userId: w.ownerId,
      projectId: w.projectId,
      type: 'requirement_step',
      title: 'REQ-901 is Agreed: Cards export',
    });
    expect(out.delivered, 'a log-tier record reaches no bell').toBe(0);
    expect(await recordsAbout('REQ-901')).toEqual([{ type: 'requirement_step', tier: 'log' }]);
    expect(await rowsAbout(w.ownerId, 'REQ-901')).toEqual([]);
  });

  it('reaches a reader as one row per feedback item, whatever the type, at its latest title', async () => {
    const { emitNotification } = await import('../../src/notifications/index.js');
    const feedbackId = randomUUID();
    await emitNotification({
      recipients: [w.ownerId],
      projectId: w.projectId,
      type: 'feedback_verify_asked',
      title: 'FB-902 · resolved · Export breaks',
      feedbackId,
      resolutionKey: `feedback-verify:${feedbackId}`,
    });
    const [first] = await rowsAbout(w.ownerId, 'FB-902');
    await rows(sql`UPDATE notification_deliveries SET read_at = now() WHERE id = ${first?.delivery}`);
    await emitNotification({
      recipients: [w.ownerId],
      projectId: w.projectId,
      type: 'feedback_message',
      title: 'FB-902 · Export breaks: which browser?',
      feedbackId,
    });
    const after = await rowsAbout(w.ownerId, 'FB-902');
    expect(after, 'two notices about one feedback item are one row').toHaveLength(1);
    expect(after[0]).toMatchObject({
      delivery: first?.delivery,
      title: 'FB-902 · Export breaks: which browser?',
      read_at: null,
    });
  });

  it('opens no check-the-criteria task where the Steward accepts by rule, and writes no Resolved row', async () => {
    const requirementId = randomUUID();
    const delivered = {
      projectId: w.projectId,
      requirementId,
      key: 'REQ-903',
      title: 'Cards export',
      revision: 6,
      at: new Date().toISOString(),
    };
    await handle('requirement.delivered', 'notify-requirements', delivered);
    await handle('requirement.accepted', 'notify-requirements', {
      ...delivered,
      acceptedBy: w.moverId,
    });
    expect(await recordsAbout('REQ-903'), 'no task is opened for a check nobody owes').toEqual([]);
    expect(await rowsAbout(w.ownerId, 'REQ-903')).toEqual([]);
  });

  it('still opens the check where a person owns the accept, one row per requirement at its latest revision', async () => {
    const requirementId = randomUUID();
    const delivered = (revision: number) => ({
      projectId: w.projectId,
      requirementId,
      key: 'REQ-904',
      title: 'Cards export',
      revision,
      at: new Date().toISOString(),
    });
    await underStrict(w.projectId, w.ownerId, async () => {
      await handle('requirement.delivered', 'notify-requirements', delivered(1));
      await handle('requirement.delivered', 'notify-requirements', delivered(2));
    });
    const bell = await rowsAbout(w.ownerId, 'REQ-904');
    expect(bell, 'two revisions of one requirement are one row').toHaveLength(1);
    expect(bell[0]?.title).toBe('REQ-904 r2 is delivered: Cards export');
  });
});
