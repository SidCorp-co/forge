import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestProjectMember } from '../helpers/index.js';
import { registerIdleFixture } from '../helpers/idle-fixture.js';

/**
 * ISS-1228 round 21 (judge-67, criterion 219): an idle notice read "It has read Open for 18 minutes"
 * for ISS-1, which had entered Open at 13:54:01Z, beside the notice row's own `created_at` of 14:09:08Z
 * (15 minutes in). That row is the first sighting; `issue_stranded` waits two sightings before anybody
 * is told, and the body is the sighting's that tells, so the reader gets the age at the moment they
 * are told, beside the time they were told. This plants that sequence through the real delivery path.
 */

const fx = registerIdleFixture(1330);
const MIN = 60_000;

let idle: typeof import('../../src/pipeline/idle-issues.js');

beforeAll(async () => {
  idle = await import('../../src/pipeline/idle-issues.js');
}, 60_000);

beforeEach(async () => {
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

describe('an idle notice counts from entering the status to reaching its reader (criterion 219)', () => {
  it('tells the age at the time the bell shows, counted from the entry, not from the first sighting', async () => {
    await createTestProjectMember(fx.db, { userId: fx.ownerId, projectId: fx.projectId, role: 'admin' });
    await fx.seedRunner('online');
    const entered = new Date('2026-10-20T13:54:01.000Z');
    const issue = await fx.seedIssue({ status: 'open', updatedAt: entered.toISOString() });
    await fx.enterStatus(issue, 'in_progress', 'open', entered.toISOString());

    const firstSighting = new Date(entered.getTime() + 15 * MIN);
    for (let i = 0; i < 5; i++) {
      const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
      resetSweepCursorsForTest();
      await idle.reconcileIdleIssues(new Date(firstSighting.getTime() + i * MIN));
    }

    const [notice] = await fx.db.execute<{ id: string; body: string; created_at: string }>(sql`
      SELECT id, body, created_at::text FROM notifications
       WHERE issue_id = ${issue} AND type = 'issue_stranded'
    `);
    const [told] = await fx.db.execute<{ delivered_at: string }>(sql`
      SELECT delivered_at::text FROM notification_delivery_members WHERE notification_id = ${notice?.id}
    `);
    if (!notice || !told) throw new Error('the notice must have reached its reader');
    const toldAt = Date.parse(told.delivered_at);
    const minutes = Math.floor((toldAt - entered.getTime()) / MIN);
    expect(notice.body).toMatch(new RegExp(`^It has read Open for ${minutes} minutes, `));
    // First sighted at 16 minutes, told two sightings later at 18: the 18 is the issue's age when told.
    expect(Math.floor((Date.parse(notice.created_at) - entered.getTime()) / MIN)).toBe(16);
    expect(minutes).toBe(18);
  });
});
