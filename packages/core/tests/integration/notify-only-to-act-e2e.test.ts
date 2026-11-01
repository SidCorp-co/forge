/**
 * ISS-863 (owner, 2026-11-01, `notify-only-to-act`): a project read 99+ notifications, most of them
 * status moves. A move that asks nothing of its reader rings no bell and stays in activity; a stop on
 * the reader (`needs_info`) rings one; repeats on one item reach the reader as one bell entry, read
 * again as new; and the project's volume by type is readable, the measure the cut is judged by.
 * Against real Postgres.
 *
 * @direct-test-of packages/core/src/notifications/notify-transitions.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser, rows } from '../helpers/factories.js';

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
    const issue = await createTestIssue(w.projectId, w.ownerId, 1, { status: 'open', createdAt: new Date() });
    await moved(issue.id, 'in_progress', 'awaiting_release');
    await moved(issue.id, 'awaiting_release', 'reopen');
    await moved(issue.id, 'awaiting_release', 'closed');
    expect(await bell(issue.id)).toEqual([]);
  });

  it('rings one bell entry for a stop on its reader, however often it repeats', async () => {
    const issue = await createTestIssue(w.projectId, w.ownerId, 2, { status: 'open', createdAt: new Date() });
    await moved(issue.id, 'in_progress', 'needs_info');
    const first = await bell(issue.id);
    expect(first).toHaveLength(1);
    await rows(sql`UPDATE notification_deliveries SET read_at = now() WHERE id = ${first[0]?.delivery}`);
    await moved(issue.id, 'open', 'needs_info');
    const after = await bell(issue.id);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.delivery)).size).toBe(1);
    expect(after[0]?.read_at, 'the repeat is new again on the one entry').toBeNull();
  });

  it("reads the project's volume by type, records and bell entries apart", async () => {
    const got = await api(w.token, 'GET', `/api/projects/${w.projectId}/notifications/volume?days=1`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.types).toEqual([{ type: 'issue_status_changed', records: 2, deliveries: 1 }]);
    expect(got.body).toMatchObject({ records: 2, deliveries: 1 });
    const bad = await api(w.token, 'GET', `/api/projects/${w.projectId}/notifications/volume?days=0`);
    expect(bad.status).toBe(400);
  });
});
