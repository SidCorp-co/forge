/**
 * What a human answer does when the session that asked is still alive — real
 * Postgres.
 *
 * ISS-873 phase 3. Under `print` an answer could only ever be a fresh dispatch:
 * the session that asked had exited with the turn. Under duplex it is parked on
 * stdin holding its runner slot, so dispatching would queue a second job BEHIND
 * the session the answer is for, and the answer would still never reach it.
 *
 * Two directions, and they are not symmetric. Sending to a session that is gone
 * loses the answer until the episode resolves; dispatching while the session is
 * alive wedges the only runner slot at RUNNER_CAP_PER_RUNNER = 1. So the send
 * is tried first and the transition is the fallback — and the fallback is
 * reached ONLY through `gone`, never through `unknown`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let deviceId: string;
let issueId: string;
let seq = 0;

let registerAnswerResume: typeof import('../../src/pipeline/answer-resume.js').registerAnswerResume;
let resumeLapsedAnswers: typeof import('../../src/pipeline/answer-resume.js').resumeLapsedAnswers;
let HooksBus: typeof import('../../src/pipeline/hooks.js').HooksBus;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  vi.mock('../../src/ws/broadcast.js', () => ({
    broadcast: vi.fn(),
    broadcastToProject: vi.fn(),
  }));
  ({ registerAnswerResume, resumeLapsedAnswers } = await import(
    '../../src/pipeline/answer-resume.js'
  ));
  ({ HooksBus } = await import('../../src/pipeline/hooks.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await harness.db.execute(sql`
    UPDATE projects SET agent_config = ${JSON.stringify({
      pipelineConfig: { mode: 'autonomous' },
    })}::jsonb WHERE id = ${projectId}
  `);
  const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
  deviceId = (await issueDeviceToken({ ownerId, name: 'd1', platform: 'linux' })).device.id;

  issueId = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${seq}, ${`q${seq}`}, 'needs_info', ${ownerId})
  `);
});

/** A job on the question issue whose session is in `state`. */
async function askingSession(opts: {
  runtimeState: string | null;
  status?: string;
  onDevice?: boolean;
  quietMinutes?: number;
}): Promise<string> {
  const runId = randomUUID();
  const sessId = randomUUID();
  const at = new Date(Date.now() - (opts.quietMinutes ?? 0) * 60_000).toISOString();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, metadata,
                                runtime_state, last_heartbeat_at)
    VALUES (${sessId}, ${projectId}, ${runId}, ${opts.onDevice === false ? null : deviceId},
            ${opts.status ?? 'running'}, ${JSON.stringify({ type: 'pipeline' })}::jsonb,
            ${opts.runtimeState}, ${at}::timestamptz)
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, issue_id, agent_session_id, device_id,
                      created_by, type, status)
    VALUES (${randomUUID()}, ${projectId}, ${runId}, ${issueId}, ${sessId}, ${deviceId},
            ${ownerId}, 'code', 'running')
  `);
  return sessId;
}

async function humanAnswers(body = 'yes, use postgres'): Promise<string> {
  const commentId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body)
    VALUES (${commentId}, ${issueId}, ${ownerId}, ${body})
  `);
  const bus = new HooksBus();
  registerAnswerResume(bus);
  await bus.emit('commentCreated', {
    issueId,
    projectId,
    actor: { type: 'user', id: ownerId },
    commentId,
    body,
  });
  return commentId;
}

async function issueStatus(): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return rows[0]?.status ?? 'gone';
}

async function inboxRows(): Promise<Array<{ kind: string; body: string | null; seq: number }>> {
  return harness.db.execute(sql`SELECT kind, body, seq FROM session_inbox ORDER BY seq`);
}

async function ageEpisode(): Promise<void> {
  await harness.db.execute(sql`
    UPDATE session_inbox SET send_requested_at = now() - interval '1 hour'
  `);
}

describe('a human answer while the session is still parked', () => {
  // cm:guard the issue must STAY at `needs_info`, and that is load-bearing rather than an omission: `turn-verdict-routes.ts` reads the same status to keep the session resident, so moving it here would end the session the answer is on its way to.
  it('sends the answer to the session and leaves the issue parked', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    expect(await issueStatus()).toBe('needs_info');
    expect(await inboxRows()).toEqual([{ kind: 'answer', body: 'yes, use postgres', seq: 1 }]);
  });

  it('falls back to a dispatch when no session is parked on the question', async () => {
    await humanAnswers();
    expect(await issueStatus()).toBe('open');
    expect(await inboxRows()).toEqual([]);
  });

  // cm:guard a session MID-TURN has not asked anything yet — the park is what makes an answer the thing it is waiting for. Writing into one lands the reply as the next turn's prompt, answering a question the agent had already moved on from.
  it('falls back when the session is working rather than waiting', async () => {
    await askingSession({ runtimeState: 'working' });
    await humanAnswers();
    expect(await issueStatus()).toBe('open');
    expect(await inboxRows()).toEqual([]);
  });

  it('falls back when the session that asked has already died', async () => {
    await askingSession({ runtimeState: 'awaiting_input', status: 'failed' });
    await humanAnswers();
    expect(await issueStatus()).toBe('open');
  });

  // cm:guard `published: false` is the ONE synchronous fallback. A session with no device has no runner to have consumed anything, so there is no race to lose — every other silence must go through `resolveSessionSend` instead.
  it('falls back at once when the parked session has no device to reach', async () => {
    await askingSession({ runtimeState: 'awaiting_input', onDevice: false });
    await humanAnswers();
    expect(await issueStatus()).toBe('open');
  });

  it('leaves a park in a project that is not running the autonomous driver alone', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({
        pipelineConfig: { mode: 'staged' },
      })}::jsonb WHERE id = ${projectId}
    `);
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    expect(await issueStatus()).toBe('needs_info');
    expect(await inboxRows()).toEqual([]);
  });
});

describe('the answer whose session turned out to be gone', () => {
  it('returns the issue to the driver once the session is terminal', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    await ageEpisode();
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'failed'`);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(1);
    expect(await issueStatus()).toBe('open');
  });

  // cm:guard the hop acts on `gone` ONLY. An `unknown` is a lapsed episode with the runner still online, and dispatching on it would put a second agent on a worktree whose session may have consumed the answer already.
  it('waits rather than dispatching while the session is still alive', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    await ageEpisode();
    // cm:guard the runner row is what makes this case `unknown` rather than `gone`. `resolveSessionSend` reads `runners.lastSeenAt` for the session's device, and a MISSING row is a fact about the box too — no runner, no liveness, `gone`. Seeding it is the only way to reach the branch this test owns.
    await harness.db.execute(sql`
      INSERT INTO runners (project_id, type, host, device_id, name, status, last_seen_at)
      VALUES (${projectId}, 'claude-code', 'device', ${deviceId}, 'r1', 'online', now())
    `);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(0);
    expect(await issueStatus()).toBe('needs_info');
  });

  it('leaves a live episode alone, however dead the session', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'failed'`);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(0);
    expect(await issueStatus()).toBe('needs_info');
  });

  // cm:guard an APPLIED message was read by the model, and re-dispatching it would answer the same question twice — once in the session that consumed it and once in a fresh job that has no idea it happened.
  it('never dispatches an answer a turn already consumed', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    await ageEpisode();
    await harness.db.execute(sql`
      UPDATE session_inbox SET applied_at = now(), applied_turn = 1
    `);
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'failed'`);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(0);
    expect(await issueStatus()).toBe('needs_info');
  });

  // cm:guard the WHOLE of the hop's idempotency, and it has no marker column: the fallback moves the issue off `needs_info`, so a handled row stops matching the scan. A second dispatch for one answer is what this asserts cannot happen.
  it('does not dispatch the same answer twice', async () => {
    await askingSession({ runtimeState: 'awaiting_input' });
    await humanAnswers();
    await ageEpisode();
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'failed'`);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(1);
    expect(await resumeLapsedAnswers(new Date(), { projectId })).toBe(0);
  });
});
