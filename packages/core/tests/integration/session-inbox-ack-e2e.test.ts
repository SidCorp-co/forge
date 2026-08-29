/**
 * RFC 0003 — the runner's two reports about one inbox message, real Postgres.
 *
 * ISS-873 phase 3/4. Both routes exist so core can stop guessing, so the
 * assertions that matter are the ones about a report core must REFUSE: an ack
 * from a device that does not own the session, and a user principal reaching a
 * runner-only fact. A forged `delivered` is the worst of the three — it is what
 * stops core falling back, so it loses a human's answer with no trace.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Vars = import('../../src/middleware/request-id.js').RequestIdVars;

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let deviceId: string;
let deviceToken: string;
let app: Hono<{ Variables: Vars }>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { agentSessionInboxRoutes } = await import('../../src/agent-sessions/inbox-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const { requireUserOrDevice } = await import('../../src/middleware/auth.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.use('/api/agent-sessions/*', requireUserOrDevice() as never);
  app.route('/api/agent-sessions', agentSessionInboxRoutes as never);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
  const issued = await issueDeviceToken({ ownerId, name: 'd1', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

async function sessionWithMessage(onDevice: string | null = deviceId): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, status, metadata,
                                last_inbox_seq)
    VALUES (${id}, ${projectId}, ${runId}, ${onDevice}, 'running',
            ${JSON.stringify({ type: 'pipeline' })}::jsonb, 1)
  `);
  await harness.db.execute(sql`
    INSERT INTO session_inbox (agent_session_id, seq, kind, intent_id, body)
    VALUES (${id}, 1, 'answer', ${randomUUID()}, 'the answer')
  `);
  return id;
}

function post(sessionId: string, path: string, body: unknown, token = deviceToken) {
  return app.request(`/api/agent-sessions/${sessionId}/inbox/1/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rowOf(sessionId: string) {
  const rows = await harness.db.execute<{
    send_outcome: string | null;
    applied_at: string | null;
    applied_turn: number | null;
  }>(sql`
    SELECT send_outcome, applied_at, applied_turn FROM session_inbox
     WHERE agent_session_id = ${sessionId}
  `);
  return rows[0];
}

describe('the inbox ack', () => {
  it('records the outcome the runner reported', async () => {
    const id = await sessionWithMessage();
    expect((await post(id, 'ack', { outcome: 'delivered' })).status).toBe(200);
    expect((await rowOf(id))?.send_outcome).toBe('delivered');
  });

  it('records gone as readily as delivered', async () => {
    const id = await sessionWithMessage();
    expect((await post(id, 'ack', { outcome: 'gone' })).status).toBe(200);
    expect((await rowOf(id))?.send_outcome).toBe('gone');
  });

  // cm:guard `unknown` is core's word for "the runner never answered". A runner reporting it is claiming a silence it is in the act of breaking, and accepting it would let one arrive that `resolveSessionSend` then reads as a live answer.
  it('refuses unknown as a reported outcome', async () => {
    const id = await sessionWithMessage();
    expect((await post(id, 'ack', { outcome: 'unknown' })).status).toBe(400);
    expect((await rowOf(id))?.send_outcome).toBeNull();
  });

  // cm:guard the discriminating case for the ownership check. Any paired runner in the fleet holds a valid device token, so without the session lookup this ack succeeds — and a forged `delivered` is exactly what stops core falling back, losing the human's answer silently.
  it('refuses an ack from a device that does not own the session', async () => {
    const id = await sessionWithMessage();
    const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
    const other = await issueDeviceToken({ ownerId, name: 'd2', platform: 'linux' });
    expect((await post(id, 'ack', { outcome: 'delivered' }, other.plaintext)).status).toBe(403);
    expect((await rowOf(id))?.send_outcome).toBeNull();
  });

  // cm:guard the OWNER of the project is refused, and that is the point of the device-principal gate: `runtimeState` and this ack are runner-only facts, and a member who could report either could park or un-park any session in their project.
  it('refuses an ack from a user principal, project owner included', async () => {
    const id = await sessionWithMessage();
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const res = await post(id, 'ack', { outcome: 'delivered' }, await signUserToken(ownerId));
    expect(res.status).toBe(403);
    expect((await rowOf(id))?.send_outcome).toBeNull();
  });

  it('refuses an ack for a session that has no device at all', async () => {
    const id = await sessionWithMessage(null);
    expect((await post(id, 'ack', { outcome: 'delivered' })).status).toBe(403);
  });
});

describe('the applied report', () => {
  // cm:guard the COMMIT point, and it is a different claim from the ack: a message written to stdin whose session dies before the turn finishes was never read by the model. Collapsing the two is how a lost answer looks delivered.
  it('stamps the turn that consumed the message', async () => {
    const id = await sessionWithMessage();
    expect((await post(id, 'applied', { turn: 3 })).status).toBe(200);
    const row = await rowOf(id);
    expect(row?.applied_at).not.toBeNull();
    expect(row?.applied_turn).toBe(3);
  });

  it('leaves applied unset when only the ack landed', async () => {
    const id = await sessionWithMessage();
    await post(id, 'ack', { outcome: 'delivered' });
    expect((await rowOf(id))?.applied_at).toBeNull();
  });

  it('refuses an applied report from another device', async () => {
    const id = await sessionWithMessage();
    const { issueDeviceToken } = await import('../../src/auth/deviceToken.js');
    const other = await issueDeviceToken({ ownerId, name: 'd2', platform: 'linux' });
    expect((await post(id, 'applied', { turn: 1 }, other.plaintext)).status).toBe(403);
    expect((await rowOf(id))?.applied_at).toBeNull();
  });
});
