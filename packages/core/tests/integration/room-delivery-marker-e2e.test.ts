/**
 * ISS-727 moved both Rocket.Chat completion bridges onto one marker-parameterized
 * pair of queries, which turned two jsonb keys that used to be SQL literals
 * (`-> 'agentChat'`, `-> 'escalation'`) into a bind parameter. A mocked `db`
 * cannot say whether `jsonb -> $1` resolves at all — Postgres overloads `->` on
 * text and int, and an untyped parameter is ambiguous — so the `::text` cast the
 * code carries is only provable here.
 *
 * Driven against a real database: that both markers bind, that the delivery claim
 * is a compare-and-set exactly one caller wins, and that the claim preserves the
 * sibling keys a bridge's own failover counter lives in.
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

describe('room-delivery marker queries', () => {
  let harness: TestDatabase;
  let claimRoomReplyDelivery: typeof import('../../src/integrations/rocketchat/room-delivery.js').claimRoomReplyDelivery;
  let hasInFlightRoomSession: typeof import('../../src/integrations/rocketchat/room-delivery.js').hasInFlightRoomSession;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    ({ claimRoomReplyDelivery, hasInFlightRoomSession } = await import(
      '../../src/integrations/rocketchat/room-delivery.js'
    ));
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    projectId = project.id;
  });

  async function seedSession(
    status: 'running' | 'completed',
    metadata: unknown,
  ): Promise<{ id: string; projectId: string; metadata: unknown }> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${null}, 'system', 'running', now())
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, messages, metadata, created_at, updated_at)
      VALUES (${id}, ${projectId}, ${runId}, ${status}, '[]'::jsonb,
        ${JSON.stringify(metadata)}::jsonb, now(), now())
    `);
    return { id, projectId, metadata };
  }

  function marker(rid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      connectionId: randomUUID(),
      rid,
      tmid: null,
      botName: 'bao',
      askedByUsername: 'someone',
      question: 'why',
      ...extra,
    };
  }

  async function readMetadata(id: string): Promise<Record<string, unknown>> {
    const rows = await harness.db.execute<{ metadata: Record<string, unknown> }>(
      sql`SELECT metadata FROM agent_sessions WHERE id = ${id}`,
    );
    return (rows as unknown as Array<{ metadata: Record<string, unknown> }>)[0]?.metadata as Record<
      string,
      unknown
    >;
  }

  for (const key of ['agentChat', 'escalation'] as const) {
    it(`finds a running ${key} session by room id`, async () => {
      await seedSession('running', { [key]: marker('room-1') });

      expect(await hasInFlightRoomSession(projectId, 'room-1', key)).toBe(true);
      expect(await hasInFlightRoomSession(projectId, 'room-2', key)).toBe(false);
    });

    it(`claims ${key} delivery exactly once`, async () => {
      const session = await seedSession('running', { [key]: marker('room-1') });

      expect(await claimRoomReplyDelivery(session as never, key)).toBe(true);
      expect(await claimRoomReplyDelivery(session as never, key)).toBe(false);

      const after = await readMetadata(session.id);
      expect(typeof (after[key] as Record<string, unknown>).deliveredAt).toBe('string');
    });
  }

  it('does not confuse one marker with the other', async () => {
    await seedSession('running', { agentChat: marker('room-1') });

    expect(await hasInFlightRoomSession(projectId, 'room-1', 'agentChat')).toBe(true);
    expect(await hasInFlightRoomSession(projectId, 'room-1', 'escalation')).toBe(false);
  });

  it('ignores a session that is no longer running', async () => {
    await seedSession('completed', { agentChat: marker('room-1') });

    expect(await hasInFlightRoomSession(projectId, 'room-1', 'agentChat')).toBe(false);
  });

  it('keeps sibling keys the claim did not write', async () => {
    const session = await seedSession('running', {
      agentChat: marker('room-1', { failover: { attempts: 2 } }),
      unrelated: { keep: true },
    });

    expect(await claimRoomReplyDelivery(session as never, 'agentChat')).toBe(true);

    const after = await readMetadata(session.id);
    expect((after.agentChat as Record<string, unknown>).failover).toEqual({ attempts: 2 });
    expect(after.unrelated).toEqual({ keep: true });
  });
});
