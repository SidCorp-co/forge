/**
 * ISS-34 — a question decided signed in to Forge (a channel approve gate, or one asked in a web
 * chat) is owed to no Rocket.Chat room, so a project with no room raises no "cannot be delivered"
 * ops alert for it. A question an agent parks with nowhere to go still raises one.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let delivery: typeof import('../../src/integrations/rocketchat/question-delivery.js');
let write: typeof import('../../src/questions/write.js');
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  delivery = await import('../../src/integrations/rocketchat/question-delivery.js');
  write = await import('../../src/questions/write.js');
});

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

const ask = (origin?: { kind: 'channel_gate'; documentId: string; number: string }) =>
  write.askQuestion({
    id: randomUUID(),
    projectId,
    prompt: 'Approve the RFI?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'a decision' },
    ...(origin ? { origin } : {}),
  });

async function undeliverableAlerts(): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT title FROM notifications
     WHERE type = 'ops_alert' AND resolution_key LIKE 'rocketchat-question-undeliverable:%'
  `)) as unknown as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

describe('a question decided on the web, in a project with no room', () => {
  it('owes no room a channel gate, and raises no alert', async () => {
    const q = await ask({ kind: 'channel_gate', documentId: randomUUID(), number: 'QE-RFI-1' });

    expect((await delivery.owedRounds()).map((r) => r.questionId)).not.toContain(q.id);
    expect(await delivery.drainQuestionDeliveries()).toMatchObject({ undeliverable: 0 });
    expect(await undeliverableAlerts()).toEqual([]);
  });

  it('owes no room a question asked in a web chat, and raises no alert', async () => {
    const q = await ask();
    await harness.db.execute(sql`
      UPDATE agent_questions SET origin = ${JSON.stringify({
        kind: 'conversation',
        adapter: 'web',
        venueId: 'web',
        conversationId: randomUUID(),
        windowId: randomUUID(),
        anchorId: null,
        askedByUserId: null,
        askedByLabel: null,
        askedByKey: null,
      })}::jsonb WHERE id = ${q.id}
    `);

    expect((await delivery.owedRounds()).map((r) => r.questionId)).not.toContain(q.id);
    expect(await undeliverableAlerts()).toEqual([]);
  });

  it('resolves the alert an earlier drain raised for a channel gate', async () => {
    const q = await ask({ kind: 'channel_gate', documentId: randomUUID(), number: 'QE-RFI-2' });
    // What the drain did before a web-decided round stopped being owed to a room.
    await harness.db.execute(sql`
      INSERT INTO rocketchat_question_deliveries (question_id, round, status, attempts)
      VALUES (${q.id}, 1, 'undeliverable', 1)
    `);
    const owner = (await harness.db.execute(sql`
      SELECT o.created_by AS id FROM projects p JOIN organizations o ON o.id = p.org_id
       WHERE p.id = ${projectId}
    `)) as unknown as Array<{ id: string }>;
    const { emitNotification } = await import('../../src/notifications/emit.js');
    await emitNotification({
      userId: owner[0]?.id as string,
      projectId,
      issueId: null,
      type: 'ops_alert',
      severity: 'warning',
      title: 'Eco B has a question waiting that cannot be delivered',
      body: 'raised before the fix',
      resolutionKey: `rocketchat-question-undeliverable:${q.id}`,
    });

    await delivery.drainQuestionDeliveries();

    const open = (await harness.db.execute(sql`
      SELECT id FROM notifications
       WHERE resolution_key = ${`rocketchat-question-undeliverable:${q.id}`} AND resolved_at IS NULL
    `)) as unknown as unknown[];
    expect(open).toEqual([]);
  });

  it('still alerts once for a question an agent parked with nowhere to go', async () => {
    const q = await ask();

    expect((await delivery.owedRounds()).map((r) => r.questionId)).toContain(q.id);
    expect(await delivery.drainQuestionDeliveries()).toMatchObject({ undeliverable: 1 });
    expect(await undeliverableAlerts()).toEqual([
      expect.stringContaining('has a question waiting that cannot be delivered'),
    ]);
  });
});
