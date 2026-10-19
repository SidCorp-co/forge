/**
 * ISS-1228 round 11 — a session core ends for going silent says what stopped. Judge-27 saw run
 * sessions failed "Runner unreachable" while their box was still heartbeating: the session had
 * stopped checking in, and the box was reachable the whole time. Each of the three reapers that ends
 * a session for silence reads whether its box answers at that moment.
 */

import { randomUUID } from 'node:crypto';
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
let projectId: string;
let deviceId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  await bindTestRunner(harness.db, { projectId, deviceId });
});

/** The box's runner last heard `ago` before now. */
async function boxHeard(ago: string): Promise<void> {
  await harness.db.execute(
    sql`UPDATE runners SET last_seen_at = now() - ${ago}::interval WHERE device_id = ${deviceId}::uuid`,
  );
}

async function session(kind: string, silentFor: string): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}::uuid, ${kind === 'master' ? 'pm' : 'system'}, 'running',
            now() - interval '1 hour')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state, claude_session_id, started_at, last_heartbeat_at)
    VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, ${kind}, 'running', ${`a ${kind}`},
            'working', 'claude-1', now() - interval '1 hour', now() - ${silentFor}::interval)
  `);
  return id;
}

async function endOf(id: string): Promise<{ status: unknown; reason: unknown }> {
  const [row] = await harness.db.execute(
    sql`SELECT status, failure_reason FROM agent_sessions WHERE id = ${id}`,
  );
  return { status: row?.status, reason: row?.failure_reason };
}

describe('a session ended for silence says what stopped (ISS-1228 round 11)', () => {
  it('says a run session stopped checking in where its box answers, and the runner was unreachable where it does not', async () => {
    const { reapDeadRunSessions } = await import('../../src/devices/run-session-reaper.js');
    await boxHeard('10 seconds');
    const answered = await session('run_session', '11 minutes');
    await reapDeadRunSessions();
    expect(await endOf(answered)).toEqual({
      status: 'failed',
      reason: 'session_stopped_checking_in',
    });

    await boxHeard('5 minutes');
    const unheard = await session('run_session', '11 minutes');
    await reapDeadRunSessions();
    expect(await endOf(unheard)).toEqual({ status: 'failed', reason: 'runner_unreachable' });
  });

  it('says the same of a master', async () => {
    const { reapSilentMasters } = await import('../../src/devices/master-reaper.js');
    await boxHeard('10 seconds');
    const answered = await session('master', '11 minutes');
    await reapSilentMasters();
    expect(await endOf(answered)).toEqual({
      status: 'failed',
      reason: 'session_stopped_checking_in',
    });

    await boxHeard('5 minutes');
    const unheard = await session('master', '11 minutes');
    await reapSilentMasters();
    expect(await endOf(unheard)).toEqual({ status: 'failed', reason: 'runner_unreachable' });
  });

  it('says the same of a session the one-shot sweep ends past the runner grace', async () => {
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await boxHeard('10 seconds');
    const answered = await session('chat', '21 minutes');
    await reapOrphanedOneShotRuns(new Date());
    expect(await endOf(answered)).toEqual({
      status: 'failed',
      reason: 'session_stopped_checking_in',
    });

    await boxHeard('5 minutes');
    const unheard = await session('chat', '4 minutes');
    await reapOrphanedOneShotRuns(new Date());
    expect(await endOf(unheard)).toEqual({ status: 'failed', reason: 'heartbeat_timeout' });
  });
});

describe('a chat waiting on its person is never failed for silence (ISS-1228 round 17)', () => {
  /** A chat whose turn ended `ago` before now, waiting for its person's reply on an open chat run. */
  async function waitingChat(ago: string): Promise<{ id: string; runId: string }> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}::uuid, 'interactive', 'running', now() - interval '3 hours')
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                  claude_session_id, started_at, last_heartbeat_at)
      VALUES (${id}, ${projectId}::uuid, ${deviceId}::uuid, ${runId}, 'chat', 'idle', 'a chat',
              'claude-1', now() - interval '3 hours', now() - ${ago}::interval)
    `);
    return { id, runId };
  }

  async function runOf(runId: string): Promise<unknown> {
    const [row] = await harness.db.execute(
      sql`SELECT status FROM pipeline_runs WHERE id = ${runId}`,
    );
    return row?.status;
  }

  it('leaves it and its run to the one-shot sweep, whether or not its box answers', async () => {
    const { reapOrphanedOneShotRuns } = await import('../../src/pipeline/sweeper.js');
    await boxHeard('10 seconds');
    const answered = await waitingChat('21 minutes');
    await boxHeard('5 minutes');
    const unheard = await waitingChat('21 minutes');
    await reapOrphanedOneShotRuns(new Date());
    for (const chat of [answered, unheard]) {
      expect(await endOf(chat.id)).toEqual({ status: 'idle', reason: null });
      expect(await runOf(chat.runId)).toBe('running');
    }
  });

  it('closes it as completed, never failed, two hours after it was last heard', async () => {
    const { closeIdleChatSessions } = await import('../../src/pipeline/sweeper.js');
    const fresh = await waitingChat('119 minutes');
    const stale = await waitingChat('121 minutes');
    await closeIdleChatSessions(new Date());
    expect(await endOf(fresh.id)).toEqual({ status: 'idle', reason: null });
    expect(await endOf(stale.id)).toEqual({ status: 'completed', reason: null });
  });
});
