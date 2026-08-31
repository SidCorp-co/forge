/**
 * ISS-888 item 2 — steering a job that is already running, against real Postgres.
 *
 * The assertion that carries this file is NOT "the text arrived". It is that a
 * person reaching into a running agent lands in `issue_intervention_events` as
 * `manual_inject` — VISION §1 metric ②. A steer that delivers without auditing
 * makes interventions-per-issue read LOWER precisely as interventions rise,
 * which is worse than having no steer at all: the number would be measuring
 * duplex adoption rather than the thing it is named after.
 *
 * The rejections are the other half. `answer` and `inject` are complementary —
 * an answer needs the park, a steer needs its absence — and each negative here
 * is a way the two doors would end up opening onto the same session.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const published: Array<{ room: string; event: string; data: Record<string, unknown> }> = [];

vi.mock('../../src/ws/server.js', () => ({
  roomManager: {
    publish: (room: string, msg: { event: string; data: Record<string, unknown> }) => {
      published.push({ room, event: msg.event, data: msg.data });
    },
  },
  isWsListening: () => true,
}));

describe('steer E2E', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    published.length = 0;
  });

  async function seed(opts: { runtimeState?: string | null; withDevice?: boolean } = {}) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = opts.withDevice === false ? null : await createTestDevice(harness.db, owner.id);

    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, created_by_id)
      VALUES (${issueId}, ${project.id}, 'steer probe', 'in_progress', ${owner.id})
    `);

    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', now())
    `);

    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id, runtime_state)
      VALUES (${sessionId}, ${project.id}, ${device?.id ?? null}, 'running', ${runId},
              ${opts.runtimeState === undefined ? 'working' : opts.runtimeState})
    `);

    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, agent_session_id,
        pipeline_run_id, payload, queued_at, dispatched_at, created_by
      )
      VALUES (
        ${jobId}, ${project.id}, ${issueId}, 'drive', 'running', ${sessionId}, ${runId},
        '{}'::jsonb, now(), now(), ${owner.id}
      )
    `);

    return { ownerId: owner.id, projectId: project.id, issueId, jobId, sessionId };
  }

  const steer = async () => (await import('../../src/agent-sessions/steer-session.js')).steerIssue;

  /** The `code` is the contract both transports map from — assert it, not the prose. */
  async function refusal(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (e) {
      return (e as { code?: string }).code ?? `no code: ${(e as Error).message}`;
    }
    throw new Error('expected a refusal, got a result');
  }

  it('delivers the instruction to the live session and records it on the issue', async () => {
    const s = await seed();

    const result = await (await steer())(s.issueId, 'stop refactoring, fix the failing test', {
      actorUserId: s.ownerId,
      reason: 'going the wrong way',
      source: 'rest',
    });

    expect(result.agentSessionId).toBe(s.sessionId);
    expect(result.jobId).toBe(s.jobId);

    const inbox = await harness.db.execute(sql`
      SELECT kind, body, intent_id, seq FROM session_inbox WHERE agent_session_id = ${s.sessionId}
    `);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.kind).toBe('inject');
    expect(inbox[0]?.body).toBe('stop refactoring, fix the failing test');
    expect(inbox[0]?.intent_id).toBe(result.commentId);

    const comment = await harness.db.execute(sql`
      SELECT body, author_id FROM comments WHERE id = ${result.commentId}
    `);
    expect(comment[0]?.body).toBe('stop refactoring, fix the failing test');
    expect(comment[0]?.author_id).toBe(s.ownerId);

    const frame = published.find((p) => p.event === 'session.send');
    expect(frame?.data.kind).toBe('inject');
    expect(frame?.data.jobId).toBe(s.jobId);
  });

  // cm:guard THIS is the assertion the feature exists to satisfy, and it is the one a passing delivery test cannot stand in for. Drop `actor` from the `requestSessionSend` call in steer-session.ts and only this goes red: the instruction still arrives, the session still runs, and a human reaching into a running agent stops being counted anywhere.
  it('charts the steer as manual_inject in the interventions view', async () => {
    const s = await seed();

    await (await steer())(s.issueId, 'use the existing helper', {
      actorUserId: s.ownerId,
      reason: 'duplicating a helper',
      source: 'mcp',
    });

    const events = await harness.db.execute(sql`
      SELECT data->>'action' AS action, data->>'actor' AS actor,
             data->>'reason' AS reason, data->>'source' AS source
      FROM job_events WHERE job_id = ${s.jobId} AND kind = 'intervention'
    `);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'inject',
      actor: s.ownerId,
      reason: 'duplicating a helper',
      source: 'mcp',
    });

    const view = await harness.db.execute(sql`
      SELECT source, detail FROM issue_intervention_events WHERE issue_id = ${s.issueId}
    `);
    expect(view).toHaveLength(1);
    expect(view[0]?.source).toBe('manual_inject');
    expect(view[0]?.detail).toBe('duplicating a helper');
  });

  // cm:guard the park belongs to `pipeline/answer-resume.ts`, and letting a steer through here is not a widening — it is a SECOND writer onto one session. The parked agent asked something; the reply would arrive as the next turn's prompt, answering a question it had already moved past.
  it('refuses a session parked on a question, and names the door that owns it', async () => {
    const s = await seed({ runtimeState: 'awaiting_input' });

    expect(
      await refusal(async () =>
        (await steer())(s.issueId, 'do it this way instead', {
          actorUserId: s.ownerId,
          reason: 'redirect',
          source: 'rest',
        }),
      ),
    ).toBe('SESSION_PARKED');

    const inbox = await harness.db.execute(sql`SELECT id FROM session_inbox`);
    expect(inbox).toHaveLength(0);
  });

  it('refuses when nothing is running the issue', async () => {
    const s = await seed();
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'completed' WHERE id = ${s.sessionId}
    `);

    expect(
      await refusal(async () =>
        (await steer())(s.issueId, 'too late', {
          actorUserId: s.ownerId,
          reason: 'redirect',
          source: 'rest',
        }),
      ),
    ).toBe('NO_LIVE_SESSION');
  });

  // cm:guard a send with no device room reaches a durable row and nothing else. Returning it as a result would tell the caller their instruction landed in an agent that will never read it — the `state-never-lies` violation item 1 is about, arriving through the door item 2 opened.
  it('refuses rather than reporting success when there is no device to deliver to', async () => {
    const s = await seed({ withDevice: false });

    expect(
      await refusal(async () =>
        (await steer())(s.issueId, 'nowhere to go', {
          actorUserId: s.ownerId,
          reason: 'redirect',
          source: 'rest',
        }),
      ),
    ).toBe('NO_DEVICE');
  });

  // cm:guard the idempotency key is the COMMENT id, so a redelivery of one intent must not queue the instruction twice. Two separate steers are two comments and therefore two rows — that is the case this distinguishes it from.
  it('gives two separate steers two rows', async () => {
    const s = await seed();
    const send = await steer();
    const opts = { actorUserId: s.ownerId, reason: 'redirect', source: 'rest' as const };

    const first = await send(s.issueId, 'first', opts);
    const second = await send(s.issueId, 'second', opts);

    expect(second.commentId).not.toBe(first.commentId);
    expect(second.seq).toBeGreaterThan(first.seq);

    const inbox = await harness.db.execute(sql`
      SELECT seq FROM session_inbox WHERE agent_session_id = ${s.sessionId} ORDER BY seq
    `);
    expect(inbox).toHaveLength(2);
  });
});
