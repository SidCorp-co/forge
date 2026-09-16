/**
 * ISS-1014 — what `applyKernelTransition` hands back, and what a bulk session
 * sweep therefore reads.
 *
 * `.returning()` with no projection is `RETURNING *`, and on `agent_sessions`
 * that is the `messages` transcript — 233 KB on average and 35 MB at the
 * largest on live beta — pulled for every row `closeIdleChatSessions` flips
 * (up to 200 a tick) to read four scalar columns off each.
 *
 * The instrument for "this sweep never touches `messages`" is a RENAME of that
 * column: any statement still naming it fails with `column ... does not exist`
 * rather than quietly working. The first test plants that failure on a
 * whole-row flip and watches it go red, which is what makes the same rename
 * standing green over the narrow sweep mean anything.
 *
 * The other half is what narrowing could have broken in silence: the two
 * completion bridges are gated on `metadata`, and the heartbeat hop in
 * `jobs/loop-monitor.ts` deliberately sweeps escalation and agent-chat
 * sessions.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const deliverEscalationReplyOnce = vi.fn(async (_row: unknown) => {});
const deliverAgentChatReplyOnce = vi.fn(async (_row: unknown) => {});
vi.mock('../../src/integrations/rocketchat/escalation-bridge.js', () => ({
  deliverEscalationReplyOnce: (row: unknown) => deliverEscalationReplyOnce(row as never),
}));
vi.mock('../../src/integrations/rocketchat/agent-chat-bridge.js', () => ({
  deliverAgentChatReplyOnce: (row: unknown) => deliverAgentChatReplyOnce(row as never),
}));

const publish = vi.fn((_room: string, _payload: unknown) => 0);
vi.mock('../../src/ws/server.js', () => ({
  roomManager: { publish },
  attachWs: vi.fn(),
  closeWs: vi.fn(async () => {}),
  wsClientCount: () => 0,
}));

import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let runId: string;
let transition: typeof import('../../src/lifecycle/transition.js');
let sweeper: typeof import('../../src/pipeline/sweeper.js');
let loopMonitor: typeof import('../../src/jobs/loop-monitor.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  transition = await import('../../src/lifecycle/transition.js');
  sweeper = await import('../../src/pipeline/sweeper.js');
  loopMonitor = await import('../../src/jobs/loop-monitor.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  publish.mockClear();
  deliverEscalationReplyOnce.mockClear();
  deliverAgentChatReplyOnce.mockClear();
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
});

/** A session with no job, quiet long enough for `closeIdleChatSessions`. */
async function idleSession(metadata: unknown = { type: 'chat' }): Promise<string> {
  const id = randomUUID();
  const long = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, messages, metadata,
                                started_at, last_heartbeat_at, updated_at, created_at)
    VALUES (${id}, ${projectId}, ${runId}, 'running',
            ${JSON.stringify([{ role: 'assistant', content: 'z'.repeat(5000) }])}::jsonb,
            ${JSON.stringify(metadata)}::jsonb,
            ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz)
  `);
  return id;
}

async function withTranscriptHidden<T>(fn: () => Promise<T>): Promise<T> {
  await harness.db.execute(
    sql.raw('ALTER TABLE agent_sessions RENAME COLUMN "messages" TO "messages__iss1014_hidden"'),
  );
  try {
    return await fn();
  } finally {
    await harness.db.execute(
      sql.raw('ALTER TABLE agent_sessions RENAME COLUMN "messages__iss1014_hidden" TO "messages"'),
    );
  }
}

async function auditRows(): Promise<number> {
  const rows = await harness.db.execute<{ n: string }>(
    sql`SELECT count(*) AS n FROM kernel_transitions WHERE entity = 'session'`,
  );
  return Number(rows[0]?.n ?? 0);
}

describe('ISS-1014 · the projection a flip hands back', () => {
  it('hands back only the named columns, plus id and metadata', async () => {
    const id = await idleSession();

    const flipped = await transition.applyKernelTransition(harness.db as never, {
      entity: 'session',
      to: 'completed',
      returning: transition.SWEEP_SESSION_COLUMNS,
      where: sql`id = ${id} AND status = 'running'` as never,
      fromStatus: 'running',
      actor: { type: 'sweeper' },
      source: 'test',
    });

    expect(flipped).toHaveLength(1);
    expect(Object.keys(flipped[0] ?? {}).sort()).toEqual([
      'deviceId',
      'id',
      'metadata',
      'pipelineRunId',
      'projectId',
      'status',
    ]);
    expect(flipped[0]?.status).toBe('completed');
  });

  it('still hands back the whole row when no projection is named', async () => {
    const id = await idleSession();

    const flipped = await transition.applyKernelTransition(harness.db as never, {
      entity: 'session',
      to: 'completed',
      where: sql`id = ${id} AND status = 'running'` as never,
      fromStatus: 'running',
      actor: { type: 'sweeper' },
      source: 'test',
    });

    expect(flipped[0]?.messages).toBeDefined();
    expect(flipped[0]?.claudeSessionId).toBeNull();
  });

  it('refuses a column name the entity does not carry, by name', async () => {
    await expect(
      transition.applyKernelTransition(harness.db as never, {
        entity: 'session',
        to: 'completed',
        returning: ['notAColumn'] as never,
        where: sql`false` as never,
        actor: { type: 'sweeper' },
        source: 'test',
      }),
    ).rejects.toThrow(/notAColumn.*not a column of `session`/);
  });
});

describe('ISS-1014 · a bulk sweep never touches the transcript', () => {
  it('goes red on a whole-row flip with the transcript column renamed away', async () => {
    const id = await idleSession();

    await withTranscriptHidden(async () => {
      await expect(
        transition.applyKernelTransition(harness.db as never, {
          entity: 'session',
          to: 'completed',
          where: sql`id = ${id} AND status = 'running'` as never,
          fromStatus: 'running',
          actor: { type: 'sweeper' },
          source: 'test',
        }),
      ).rejects.toThrow(/messages/);
    });
  });

  it('closes 3 idle chat sessions with the transcript column renamed away', async () => {
    const ids = [await idleSession(), await idleSession(), await idleSession()];

    const result = await withTranscriptHidden(() => sweeper.closeIdleChatSessions());

    expect(result).toEqual({ closed: 3 });
    const rows = await harness.db.execute<{ id: string; status: string }>(
      sql`SELECT id::text AS id, status FROM agent_sessions`,
    );
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(await auditRows()).toBe(3);
    const statusPublishes = publish.mock.calls.filter(
      (c) => (c[1] as { event?: string } | undefined)?.event === 'agent-session.status',
    );
    expect(statusPublishes).toHaveLength(3);
    expect(deliverEscalationReplyOnce).not.toHaveBeenCalled();
    expect(deliverAgentChatReplyOnce).not.toHaveBeenCalled();
  });
});

describe('ISS-1014 · a bridge-marked session still gets its whole row', () => {
  it('hydrates and delivers an escalation session swept under a narrow returning', async () => {
    await idleSession({ type: 'chat', escalation: { rid: 'room-1', question: 'q' } });

    const result = await sweeper.closeIdleChatSessions();

    expect(result).toEqual({ closed: 1 });
    await vi.waitFor(() => expect(deliverEscalationReplyOnce).toHaveBeenCalledTimes(1));
    const row = deliverEscalationReplyOnce.mock.calls[0]?.[0] as unknown as {
      messages?: unknown;
      status?: string;
      failureReason?: unknown;
    };
    expect(row.messages).toBeDefined();
    expect(row.status).toBe('completed');
    expect(row).toHaveProperty('failureReason');
  });

  it('hydrates and delivers an agent-chat session swept under a narrow returning', async () => {
    await idleSession({ type: 'chat', agentChat: { rid: 'room-2' } });

    const result = await sweeper.closeIdleChatSessions();

    expect(result).toEqual({ closed: 1 });
    await vi.waitFor(() => expect(deliverAgentChatReplyOnce).toHaveBeenCalledTimes(1));
    const row = deliverAgentChatReplyOnce.mock.calls[0]?.[0] as unknown as { messages?: unknown };
    expect(row.messages).toBeDefined();
  });

  it('delivers nothing for the unmarked sessions swept in the same batch', async () => {
    await idleSession({ type: 'chat', agentChat: { rid: 'room-3' } });
    await idleSession();
    await idleSession();

    expect(await sweeper.closeIdleChatSessions()).toEqual({ closed: 3 });

    await vi.waitFor(() => expect(deliverAgentChatReplyOnce).toHaveBeenCalledTimes(1));
    expect(deliverEscalationReplyOnce).not.toHaveBeenCalled();
    expect(await auditRows()).toBe(3);
  });
});

describe('ISS-1014 · the zombie sweep keeps its broadcast and its wedge', () => {
  it('reaps a queued pipeline session with the transcript column renamed away', async () => {
    const id = randomUUID();
    const long = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata,
                                  dispatched_at, updated_at, created_at)
      VALUES (${id}, ${projectId}, ${runId}, 'queued', ${JSON.stringify({ type: 'pipeline' })}::jsonb,
              ${long}::timestamptz, ${long}::timestamptz, ${long}::timestamptz)
    `);

    const result = await withTranscriptHidden(() => loopMonitor.reapZombieSessions(new Date()));

    expect(result.queueTimedOut).toBe(1);
    const rows = await harness.db.execute<{ status: string; failure_reason: string | null }>(
      sql`SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}`,
    );
    expect(rows[0]).toMatchObject({ status: 'failed', failure_reason: 'queue_timeout' });
    expect(await auditRows()).toBe(1);
    const statusPublishes = publish.mock.calls.filter(
      (c) => (c[1] as { event?: string } | undefined)?.event === 'agent-session.status',
    );
    expect(statusPublishes).toHaveLength(1);
    const wedges = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM notifications WHERE type = 'pipeline_wedge'`,
    );
    expect(Number(wedges[0]?.n)).toBe(1);
  });
});
