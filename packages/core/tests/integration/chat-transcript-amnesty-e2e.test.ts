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
  createTestProjectMember,
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
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
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
  const { agentSessionTurnsRoutes } = await import('../../src/agent-sessions/turns-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: Vars }>();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes as never);
  app.route('/api/agent-sessions', agentSessionTurnsRoutes as never);
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  app.onError(errorHandler);

  ({ seedTurn } = await import('../../src/agent-sessions/session-events.js'));
  ({ db } = await import('../../src/db/client.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
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

describe('a box upgraded mid-conversation keeps the turns the old daemon answered', () => {
  // cm:guard this is the rolling upgrade, and it is the shape the whole amnesty
  // is for: core ships first, the boxes follow. A turn answered by the previous
  // release never reaches the carrier, so the first derive after the upgrade
  // rebuilds the session from a carrier holding the prompts and this turn's
  // lines — and writes that over a conversation that had the answers in it.
  it('keeps an old daemon’s answer when the next turn is derived from the carrier', async () => {
    const s = await chatSession();
    const id = idOf(s);

    // Turn one, answered by a daemon on the previous release.
    const first = await patchSession(id, {
      status: 'completed',
      toolCallCount: 1,
      messages: [
        { type: 'user', content: 'what did you do?' },
        { type: 'assistant', content: 'the old daemon answered' },
      ],
    });
    expect(first.status).toBe(200);

    // The box is upgraded. Turn two is dispatched the way `chat-turn.ts` does it,
    // and answered on the wire.
    const stored = await transcriptOf(id);
    const seeded = await seedTurn(db, id, {
      priorMessages: stored,
      entry: { id: randomUUID(), type: 'user', content: 'and now?', timestamp: 2 },
      at: new Date(),
    });
    // `dispatchChatTurn` flips the row back to `running` in the same transaction
    // as that seed; the carrier route refuses a terminal session by design.
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${id}`);
    expect((await postLines(id, aTurnThatRanTools(seeded.lastSeq))).status).toBe(200);
    expect((await patchSession(id, { status: 'completed' })).status).toBe(200);

    const messages = await transcriptOf(id);
    const said = messages.map((m) => String(m.content ?? ''));
    expect(said).toContain('what did you do?');
    expect(said).toContain('the old daemon answered');
    expect(said).toContain('and now?');
    // The new turn's own work is there too — this is a fold, not a restore.
    const blocks = messages.flatMap((m) =>
      Array.isArray(m.blocks) ? (m.blocks as Array<Record<string, unknown>>) : [],
    );
    expect(blocks.filter((b) => b.type === 'tool')).toHaveLength(1);
  });
});

describe('a turn edited by hand is not put back by the next derive', () => {
  // cm:guard an edit rewrites `messages` past the carrier, and a chat session's
  // transcript is REBUILT by folding that carrier — so an edit the carrier never
  // saw is one the next turn's derive hands straight back, with the person
  // looking at the words they replaced.
  it('keeps the edited text through the turn that follows it', async () => {
    const s = await chatSession();
    const id = idOf(s);
    expect((await postLines(id, aTurnThatRanTools(baseOf(s)))).status).toBe(200);
    expect((await patchSession(id, { status: 'completed' })).status).toBe(200);

    const turns = (await harness.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM agent_session_turns
          WHERE agent_session_id = ${id} AND role = 'user' ORDER BY turn_index LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    const turnId = (turns[0] as { id: string }).id;

    const token = await signUserToken(ownerId);
    const edited = await app.request(`/api/agent-sessions/${id}/turns/${turnId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'what did you ACTUALLY do?' }),
    });
    expect(edited.status).toBe(200);

    // The next turn, dispatched and answered on the wire.
    const seeded = await seedTurn(db, id, {
      priorMessages: await transcriptOf(id),
      entry: { id: randomUUID(), type: 'user', content: 'and now?', timestamp: 3 },
      at: new Date(),
    });
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${id}`);
    expect((await postLines(id, aTurnThatRanTools(seeded.lastSeq))).status).toBe(200);
    expect((await patchSession(id, { status: 'completed' })).status).toBe(200);

    const said = (await transcriptOf(id)).map((m) => String(m.content ?? ''));
    expect(said).toContain('what did you ACTUALLY do?');
    expect(said).not.toContain('what did you do?');
  });

  it('refuses the edit while a turn is in flight rather than eating the runner’s next line', async () => {
    const s = await chatSession();
    const id = idOf(s);
    expect((await postLines(id, aTurnThatRanTools(baseOf(s)))).status).toBe(200);
    expect((await patchSession(id, { status: 'completed' })).status).toBe(200);
    const turns = (await harness.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM agent_session_turns
          WHERE agent_session_id = ${id} AND role = 'user' ORDER BY turn_index LIMIT 1`,
    )) as unknown as Array<{ id: string }>;
    const turnId = (turns[0] as { id: string }).id;
    await harness.db.execute(sql`UPDATE agent_sessions SET status = 'running' WHERE id = ${id}`);

    const token = await signUserToken(ownerId);
    const res = await app.request(`/api/agent-sessions/${id}/turns/${turnId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'too late' }),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('SESSION_RUNNING');
  });
});

describe('core’s own rows and the runner’s numbering meet in one place', () => {
  // cm:guard the seq the runner was handed can stop being free: core takes the
  // next one whenever it records a wholesale write (an edit, a regeneration, an
  // old daemon's array). `ON CONFLICT DO NOTHING` would call the runner's line a
  // duplicate and answer 200, and that line — a part of the person's
  // conversation — would be gone with nothing said.
  it('refuses a line whose seq core already holds, rather than calling it a duplicate', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const base = baseOf(s);
    const { recordReportedTranscript } = await import('../../src/agent-sessions/session-events.js');
    const { db } = await import('../../src/db/client.js');
    await recordReportedTranscript(
      db,
      id,
      [{ type: 'user', content: 'edited by hand' }],
      new Date(),
    );

    const res = await postLines(id, [
      {
        seq: base + 1,
        line: { type: 'assistant', message: { content: [{ type: 'text', text: 'mine' }] } },
      },
    ]);
    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('SEQ_TAKEN_BY_CORE');
    expect(body).toContain(`seq ${base + 1}`);
    // The row core wrote is still the one standing.
    const kinds = (await harness.db.execute<{ kind: string }>(
      sql`SELECT kind FROM agent_session_events WHERE agent_session_id = ${id} ORDER BY seq`,
    )) as unknown as Array<{ kind: string }>;
    expect(kinds.map((k) => k.kind)).toEqual(['seed', 'snapshot']);
  });

  // cm:guard the check and the insert take ONE turn, not two. A check outside the
  // transaction only narrows the window: core takes the next free `seq` whenever
  // it records a wholesale write, and one committing between the check and the
  // insert is swallowed in exactly the same silence. The interleaving is made
  // deterministic here by holding the advisory lock both writers take.
  it('waits for a snapshot committing under it rather than swallowing the line', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const base = baseOf(s);
    const held = await harness.client.reserve();
    let posted: Promise<Response> | null = null;
    try {
      await held.unsafe('BEGIN');
      await held.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
      posted = postLines(id, [
        {
          seq: base + 1,
          line: { type: 'assistant', message: { content: [{ type: 'text', text: 'mine' }] } },
        },
      ]);
      await waitForAdvisoryWaiter();
      await held.unsafe(
        `INSERT INTO agent_session_events (agent_session_id, kind, data, seq)
         VALUES ($1, 'snapshot', '{"entries":[]}'::jsonb, $2)`,
        [id, base + 1],
      );
      await held.unsafe('COMMIT');
    } finally {
      held.release();
    }
    const res = await (posted as Promise<Response>);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('SEQ_TAKEN_BY_CORE');
  });
});

/** Wait until a backend is parked on the session's advisory lock. */
async function waitForAdvisoryWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rows = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%pg_advisory_xact_lock%'
    `);
    if (Number((rows[0] as { n: number } | undefined)?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the events route never waited on the carrier lock');
}
