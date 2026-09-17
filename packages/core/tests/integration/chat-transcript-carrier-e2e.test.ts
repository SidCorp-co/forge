/**
 * ISS-1030 — a chat turn's transcript, derived from the lines it produced,
 * against real Postgres.
 *
 * The producer half of this issue is a claim about what a chat session STORES,
 * and every earlier attempt to answer it was a claim about a parser. So these
 * cases post raw stream-json lines exactly as the runner does and then read
 * `agent_sessions.messages` back: what the transcript says is the assertion, not
 * what any function returned.
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

describe('a chat turn stores what it actually did', () => {
  it('names every tool it ran, with what came back, and carries its todos, pauses and totals', async () => {
    const s = await chatSession();
    const id = idOf(s);
    expect((await postLines(id, aTurnThatRanTools(baseOf(s)))).status).toBe(200);
    expect((await patchSession(id, { status: 'completed' })).status).toBe(200);

    const messages = await transcriptOf(id);
    // The prompt the person typed survives — it is not on the wire at all.
    expect(messages[0]).toMatchObject({ type: 'user', content: 'what did you do?' });

    const assistant = messages.find((m) => m.type === 'assistant') as
      | {
          toolCalls?: Array<Record<string, unknown>>;
          blocks?: Array<Record<string, unknown>>;
          thinkingCount?: number;
        }
      | undefined;
    // cm:guard the tool call AND its output: before ISS-1030 the runner's own
    // parser kept assistant text and returned nothing for every other frame, so a
    // chat transcript could not say a tool had run at all.
    const read = assistant?.toolCalls?.find((t) => t.name === 'Read');
    expect(read).toMatchObject({ name: 'Read', output: 'file body' });
    expect(read?.durationMs).toBeTypeOf('number');

    // cm:guard read off the ORDERED blocks, which is what the thread draws. The
    // fold merges consecutive assistant lines into one growing entry — the same
    // merge the pipeline path uses — so `content` holds the last line's text
    // while `blocks` accumulate in the order they arrived.
    const blocks = messages.flatMap((m) =>
      Array.isArray(m.blocks) ? (m.blocks as Array<Record<string, unknown>>) : [],
    );
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'todos']);
    expect(blocks[0]).toMatchObject({ text: 'Let me look.' });
    expect(blocks.find((b) => b.type === 'todos')).toMatchObject({
      todos: [{ content: 'read the file', status: 'completed' }],
    });

    const totals = messages.find((m) => m.totals !== undefined)?.totals as
      | Record<string, unknown>
      | undefined;
    expect(totals).toMatchObject({ totalCostUsd: 0.42, numTurns: 3 });

    // The Claude session id came off the `system/init` line, not off a PATCH.
    const rows = await harness.db.execute<{ claude_session_id: string | null }>(
      sql`SELECT claude_session_id FROM agent_sessions WHERE id = ${id}`,
    );
    expect((rows[0] as { claude_session_id?: string }).claude_session_id).toBe('claude-abc');
  });

  it("carries the turn's pauses in the shape every other producer uses", async () => {
    const s = await chatSession();
    const id = idOf(s);
    await postLines(id, [
      {
        seq: baseOf(s) + 1,
        line: {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: '' },
              { type: 'redacted_thinking' },
              { type: 'text', text: 'done' },
            ],
          },
        },
      },
    ]);
    await patchSession(id, { status: 'completed' });
    // cm:guard `thinkingCount` and not a `thinking` block, because that is what
    // Claude Code's derive writes and this issue's rule is that a chat turn is
    // folded by the SAME parser as every other producer — measured on beta, all
    // 12,899 thinking blocks in three days carried an empty string, which is why
    // the parser counts them (ISS-1079).
    const turn = (await transcriptOf(id)).find((m) => m.type === 'assistant');
    expect(turn?.thinkingCount).toBe(2);
  });

  it('marks a failed tool result as failed rather than as an ordinary answer', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const base = baseOf(s);
    await postLines(id, [
      {
        seq: base + 1,
        line: {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tc9', name: 'Bash', input: {} }] },
        },
      },
      {
        seq: base + 2,
        line: {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tc9', content: 'boom', is_error: true }],
          },
        },
      },
    ]);
    await patchSession(id, { status: 'completed' });
    const call = (await transcriptOf(id))
      .flatMap((m) =>
        Array.isArray(m.toolCalls) ? (m.toolCalls as Array<Record<string, unknown>>) : [],
      )
      .find((t) => t.id === 'tc9');
    expect(call).toMatchObject({ isError: true, output: 'boom' });
  });
});

describe('the delivery contract', () => {
  it('stores each line once when the identical batch is posted twice', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const batch = aTurnThatRanTools(baseOf(s));
    const first = await postLines(id, batch);
    const second = await postLines(id, batch);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ accepted: 0, duplicates: batch.length });

    // cm:guard asserted on the TRANSCRIPT and not only on a row count: a retried
    // batch that stored a second copy would read as the turn saying everything
    // twice, which is what a reader would actually see.
    expect(await storedSeqs(id)).toHaveLength(batch.length + 1);
    await patchSession(id, { status: 'completed' });
    const blocks = (await transcriptOf(id)).flatMap((m) =>
      Array.isArray(m.blocks) ? (m.blocks as Array<Record<string, unknown>>) : [],
    );
    expect(blocks.filter((b) => b.text === 'Let me look.')).toHaveLength(1);
    expect(blocks.filter((b) => b.type === 'tool')).toHaveLength(1);
    expect(blocks.filter((b) => b.type === 'todos')).toHaveLength(1);
  });

  it('yields the whole transcript in source order when a batch arrives after a later one', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const base = baseOf(s);
    const [first, second, third] = [
      {
        seq: base + 1,
        line: { type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } },
      },
      {
        seq: base + 2,
        line: { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
      },
      {
        seq: base + 3,
        line: { type: 'assistant', message: { content: [{ type: 'text', text: 'three' }] } },
      },
    ];

    // The middle batch is delayed: 3 lands, then 2, then 1.
    expect((await postLines(id, [third])).status).toBe(200);
    expect((await postLines(id, [second])).status).toBe(200);
    expect((await postLines(id, [first])).status).toBe(200);
    await patchSession(id, { status: 'completed' });

    // cm:guard the ASSERTION is the order the lines left the CLI, not the order
    // they arrived. A `> lastSeq` cursor would have folded 3, checkpointed there,
    // and excluded 1 and 2 for ever.
    const said = (await transcriptOf(id))
      .flatMap((m) => (Array.isArray(m.blocks) ? (m.blocks as Array<Record<string, unknown>>) : []))
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    expect(said).toEqual(['one', 'two', 'three']);
  });

  it('refuses a batch by the seq of the line it cannot represent, and stores none of it', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const base = baseOf(s);
    const res = await postLines(id, [
      {
        seq: base + 1,
        line: { type: 'assistant', message: { content: [{ type: 'text', text: 'good' }] } },
      },
      { seq: base + 2, line: 'not a stream-json object' },
      { seq: base + 3, line: { type: 'result', total_cost_usd: 1 } },
    ]);
    expect(res.status).toBe(400);
    // cm:guard the refusal NAMES the seq. A 400 saying only "bad request" leaves
    // an operator with a turn that stopped and no way to find out where, which is
    // the difference this criterion is about.
    expect(JSON.stringify(await res.json())).toContain(`seq ${base + 2}`);

    // cm:guard NOTHING is stored, and the good lines are refused with the bad
    // one. Keeping them would leave a hole in the seq run, and the fold holds at
    // a hole for ever — so the transcript would stop there looking exactly like a
    // turn that went quiet.
    expect(await storedSeqs(id)).toEqual([base]);
  });

  it.each([
    ['a line that is absent', undefined],
    ['a line that is null', null],
    ['a line with no `type`', { message: { content: [] } }],
    ['a line that is an array', [{ type: 'assistant' }]],
  ])('refuses %s', async (_name, line) => {
    const s = await chatSession();
    const id = idOf(s);
    const res = await app.request(`/api/agent-sessions/${id}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ seq: baseOf(s) + 1, kind: 'stdout', data: line === undefined ? {} : { line } }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await storedSeqs(id)).toEqual([baseOf(s)]);
  });

  it('refuses a batch that numbers one line twice', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const line = { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } };
    const res = await postLines(id, [
      { seq: baseOf(s) + 1, line },
      { seq: baseOf(s) + 1, line },
    ]);
    expect(res.status).toBe(400);
    expect(await storedSeqs(id)).toEqual([baseOf(s)]);
  });

  // cm:guard the discriminating case for the device gate: a project OWNER is
  // refused. The transcript is derived precisely so nobody can write one by hand,
  // and a user principal reaching this route would be exactly that.
  it('refuses a user principal, project owner included', async () => {
    const s = await chatSession();
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const res = await postLines(
      idOf(s),
      [{ seq: baseOf(s) + 1, line: { type: 'result' } }],
      await signUserToken(ownerId),
    );
    expect(res.status).toBe(403);
    expect(await storedSeqs(idOf(s))).toEqual([baseOf(s)]);
  });

  it('refuses a device that does not own the session', async () => {
    const s = await chatSession();
    const { pairDevice } = await import('../helpers/pair-device.js');
    const other = await pairDevice({ ownerId, name: 'other-box', platform: 'linux' });
    const res = await postLines(
      idOf(s),
      [{ seq: baseOf(s) + 1, line: { type: 'result' } }],
      other.plaintext,
    );
    expect(res.status).toBe(403);
  });
});

describe('a turn that ends badly says so on the transcript', () => {
  it('records a refused delivery as an entry rather than letting the turn read as finished', async () => {
    const s = await chatSession();
    const id = idOf(s);
    const res = await patchSession(id, {
      status: 'failed',
      turnError: '[TRANSCRIPT_REFUSED] core refused this turn’s transcript and stored none of it',
    });
    expect(res.status).toBe(200);
    const messages = await transcriptOf(id);
    const said = messages.find((m) => m.type === 'system');
    expect(said?.content).toContain('TRANSCRIPT_REFUSED');
    const rows = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM agent_sessions WHERE id = ${id}`,
    );
    expect((rows[0] as { status: string }).status).toBe('failed');
  });
});
