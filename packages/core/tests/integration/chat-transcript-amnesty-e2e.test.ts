/**
 * ISS-1030 — the amnesty that keeps a daemon on the previous release working,
 * against real Postgres.
 *
 * That daemon PATCHes its whole `messages` array in the legacy shape, and both
 * readers in the product lost their branch for it. So the amnesty CONVERTS on
 * the way in rather than recording what arrives — and these cases read the
 * result back through the reader that lost its branch, because that is the only
 * thing that proves the conversion was the point rather than the paperwork.
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
let seedTurn: typeof import('../../src/agent-sessions/session-events.js').seedTurn;
let db: typeof import('../../src/db/client.js').db;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';

  const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes as never);
  app.onError(errorHandler);

  ({ seedTurn } = await import('../../src/agent-sessions/session-events.js'));
  ({ db } = await import('../../src/db/client.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name: 'box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

/** A chat session on this box, with the user turn already seeded as core writes it. */
async function chatSession(opts: { messages?: unknown[] } = {}): Promise<string> {
  const id = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${projectId}, 'interactive', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, device_id, pipeline_run_id, status, messages, metadata)
    VALUES (${id}, ${projectId}, ${ownerId}, ${deviceId}, ${runId}, 'running',
            ${JSON.stringify(opts.messages ?? [])}::jsonb, ${JSON.stringify({ type: 'agent' })}::jsonb)
  `);
  const seeded = await seedTurn(db, id, {
    priorMessages: opts.messages ?? [],
    entry: { id: randomUUID(), type: 'user', content: 'what did you do?', timestamp: 1 },
    at: new Date(),
  });
  return `${id}|${seeded.lastSeq}`;
}

const idOf = (s: string) => s.split('|')[0] as string;
const baseOf = (s: string) => Number(s.split('|')[1]);

async function postLines(
  sessionId: string,
  events: Array<{ seq: number; line: unknown }>,
  token = deviceToken,
): Promise<Response> {
  return app.request(`/api/agent-sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      events: events.map((e) => ({ seq: e.seq, kind: 'stdout', data: { line: e.line } })),
    }),
  });
}

async function patchSession(sessionId: string, body: unknown, token = deviceToken) {
  return app.request(`/api/agent-sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function transcriptOf(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await harness.db.execute<{ messages: unknown }>(
    sql`SELECT messages FROM agent_sessions WHERE id = ${sessionId}`,
  );
  const messages = (rows[0] as { messages?: unknown } | undefined)?.messages;
  return Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
}

async function storedSeqs(sessionId: string): Promise<number[]> {
  const rows = await harness.db.execute<{ seq: number }>(
    sql`SELECT seq FROM agent_session_events WHERE agent_session_id = ${sessionId} ORDER BY seq`,
  );
  return (rows as Array<{ seq: number | string }>).map((r) => Number(r.seq));
}

/** One turn's worth of the wire: a tool call, its result, todos, a pause, the totals. */
function aTurnThatRanTools(base: number) {
  return [
    { seq: base + 1, line: { type: 'system', subtype: 'init', session_id: 'claude-abc' } },
    {
      seq: base + 2,
      line: {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'tc1', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      },
    },
    {
      seq: base + 3,
      line: {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tc1', content: 'file body', is_error: false },
          ],
        },
      },
    },
    {
      seq: base + 4,
      line: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tc2',
              name: 'TodoWrite',
              input: { todos: [{ content: 'read the file', status: 'completed' }] },
            },
          ],
        },
      },
    },
    {
      seq: base + 5,
      line: { type: 'result', total_cost_usd: 0.42, num_turns: 3, duration_ms: 900 },
    },
  ];
}

describe('a daemon on the previous release keeps working, and what it sends is converted', () => {
  it('rewrites a legacy whole-array PATCH into the canonical shape on the way in', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const res = await patchSession(id, {
      status: 'completed',
      toolCallCount: 2,
      messages: [
        { role: 'user', content: 'what did you do?' },
        {
          role: 'assistant',
          content: 'I read a file.',
          contentBlocks: [{ type: 'text', text: 'I read a file.' }],
        },
      ],
    });
    expect(res.status).toBe(200);

    const messages = await transcriptOf(id);
    // cm:guard read back through the ONE-shape readers, which is the whole point
    // of converting on the way in rather than recording what the daemon sent: the
    // backfill has run and both readers lost their `role` branch, so an entry
    // stored as it arrived would be one no reader left in the product can read.
    const { messageRoleToTurnRole } = await import('../../src/agent-sessions/turns-helpers.js');
    expect(messages.map((m) => messageRoleToTurnRole(m))).toEqual(['user', 'assistant']);
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      blocks: [{ type: 'text', text: 'I read a file.' }],
    });
    expect(messages[1]).not.toHaveProperty('role');
    expect(messages[1]).not.toHaveProperty('contentBlocks');
  });

  it('refuses an entry the canonical shape cannot represent, naming it, and writes nothing', async () => {
    const s = await chatSession({ messages: [] });
    const id = idOf(s);
    const before = await transcriptOf(id);
    const res = await patchSession(id, {
      status: 'completed',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'moderator', content: 'nope' },
      ],
    });
    expect(res.status).toBe(400);
    expect(await transcriptOf(id)).toEqual(before);
  });

  // cm:guard the amnesty and the new path must not both write. A daemon on the
  // previous release owns its transcript; deriving over it would replace what it
  // reported with the prompts and none of the answers.
  it('leaves an old daemon’s reported transcript alone rather than deriving over it', async () => {
    const s = await chatSession();
    const id = idOf(s);
    // The carrier holds a full turn, so a derive here WOULD write something
    // else — without these lines the assertion below could not fail.
    const posted = await postLines(id, aTurnThatRanTools(baseOf(s)));
    expect(posted.status).toBe(200);
    // the seeded user turn, then the five lines of the wire
    expect(await storedSeqs(id)).toEqual([1, 2, 3, 4, 5, 6]);

    await patchSession(id, {
      status: 'completed',
      toolCallCount: 0,
      messages: [{ type: 'assistant', content: 'the old daemon said this' }],
    });
    const messages = await transcriptOf(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: 'the old daemon said this' });
  });
});
