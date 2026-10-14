/**
 * ISS-1241 — a session's message count says what the session did, or says the lane keeps none.
 *
 * master and run_session sessions run in a box's own claude process and never put a transcript in
 * core, so a `0` or a ledger-less `null` for them read as "said nothing" about sessions that ran for
 * hours. Each case seeds one lane and reads it back through every surface that serves the count: the
 * project REST list and detail routes, the cross-project list, and the `forge_agent_sessions` MCP
 * list and get tools. Recorded lanes are written through `syncTurnsWithMessages`, the one writer,
 * so the ledger the count reads is the ledger production writes.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
let syncTurnsWithMessages: typeof import('../../src/agent-sessions/turns-helpers.js')['syncTurnsWithMessages'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [readMod, listMod, patMod, turnsMod, errMod, jwtMod] = await Promise.all([
    import('../../src/agent-sessions/project-read-routes.js'),
    import('../../src/agent-sessions/routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/agent-sessions/turns-helpers.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/jwt.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  syncTurnsWithMessages = turnsMod.syncTurnsWithMessages;
  app = new Hono();
  app.route('/api/projects', readMod.agentSessionProjectReadRoutes);
  app.route('/api/agent-sessions', listMod.agentSessionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** `token` reads the REST routes as the user; `pat` reads the MCP tools as an agent holding a credential. */
type World = { projectId: string; token: string; pat: string };

async function seedWorld(): Promise<World> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}::uuid`,
  );
  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'a reader of sessions',
    boundProjectId: project.id,
  });
  return { projectId: project.id, token: await signUserToken(user.id), pat: plaintext };
}

type Kind = 'master' | 'run_session' | 'pipeline' | 'pm' | 'chat';

/** A session row of one lane, holding `messages` as its transcript and no ledger rows yet. */
async function insertSession(
  w: World,
  kind: Kind,
  messages: unknown[],
  opts: { status?: string } = {},
): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${w.projectId}::uuid, 'interactive', 'running')
  `);
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status, messages)
    VALUES (${w.projectId}::uuid, ${runId}::uuid, ${kind}, ${opts.status ?? 'completed'},
            ${JSON.stringify(messages)}::jsonb)
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

const say = (role: 'user' | 'assistant', i: number) => ({
  id: `m${i}`,
  type: role,
  timestamp: '2026-10-14T00:00:00.000Z',
  content: `turn ${i}`,
});

const transcriptOf = (n: number) =>
  Array.from({ length: n }, (_, i) => say(i % 2 ? 'assistant' : 'user', i));

/** Put `messages` in the ledger the way production does, from an empty prior transcript. */
async function writeLedger(sessionId: string, prev: unknown[], next: unknown[]) {
  await syncTurnsWithMessages(sessionId, prev, next);
}

const rest = (path: string, token: string) =>
  app.request(path, { headers: { Authorization: `Bearer ${token}` } });

type Row = {
  id: string;
  messageCount: number | null;
  transcript: string;
  totalMessages?: number | null;
};

async function viaRestList(w: World, id: string): Promise<Row> {
  const res = await rest(`/api/projects/${w.projectId}/agent-sessions?limit=200`, w.token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: Row[] };
  const row = body.sessions.find((s) => s.id === id);
  if (!row) throw new Error(`session ${id} is not in the project list`);
  return row;
}

async function viaCrossProjectList(w: World, id: string): Promise<Row> {
  const res = await rest(`/api/agent-sessions?projectId=${w.projectId}&pageSize=100`, w.token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Row[] };
  const row = body.items.find((s) => s.id === id);
  if (!row) throw new Error(`session ${id} is not in the cross-project list`);
  return row;
}

async function viaRestGet(w: World, id: string): Promise<Row> {
  const res = await rest(`/api/projects/${w.projectId}/agent-sessions/${id}`, w.token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { session: Row }).session;
}

async function viaMcp(w: World, id: string): Promise<{ list: Row; get: Row }> {
  const ctx = await connectClientAsPat(w.pat);
  try {
    const listed = parseToolResult(
      (await ctx.client.callTool({
        name: 'forge_agent_sessions.list',
        arguments: { projectId: w.projectId, limit: 200 },
      })) as never,
    ) as { sessions: Row[] };
    const list = listed.sessions.find((s) => s.id === id);
    if (!list) throw new Error(`session ${id} is not in the MCP list`);
    const got = parseToolResult(
      (await ctx.client.callTool({
        name: 'forge_agent_sessions.get',
        arguments: { sessionId: id },
      })) as never,
    ) as { session: Row };
    return { list, get: got.session };
  } finally {
    await ctx.close();
  }
}

/** Every surface's reading of one session. */
async function readEverywhere(w: World, id: string) {
  const [restList, crossList, restGet, mcp] = await Promise.all([
    viaRestList(w, id),
    viaCrossProjectList(w, id),
    viaRestGet(w, id),
    viaMcp(w, id),
  ]);
  return { restList, crossList, restGet, mcpList: mcp.list, mcpGet: mcp.get };
}

describe('a session that keeps no transcript in core refuses a count', () => {
  for (const kind of ['master', 'run_session'] as const) {
    it(`${kind}: a session that did work reads null and not-recorded on every surface, never 0`, async () => {
      const w = await seedWorld();
      const id = await insertSession(w, kind, []);
      const r = await readEverywhere(w, id);

      for (const row of [r.restList, r.crossList, r.restGet, r.mcpList, r.mcpGet]) {
        expect(row.messageCount).toBeNull();
        expect(row.transcript).toBe('not-recorded');
      }
      expect(r.restGet.totalMessages).toBeNull();
      expect(r.mcpGet.totalMessages).toBeNull();
    });
  }
});

describe('a session that records a transcript reads its length', () => {
  for (const kind of ['chat', 'pipeline', 'pm'] as const) {
    it(`${kind}: a 4-entry transcript written through the turn writer reads 4 everywhere`, async () => {
      const w = await seedWorld();
      const messages = transcriptOf(4);
      const id = await insertSession(w, kind, messages);
      await writeLedger(id, [], messages);
      const r = await readEverywhere(w, id);

      for (const row of [r.restList, r.crossList, r.restGet, r.mcpList, r.mcpGet]) {
        expect(row.messageCount).toBe(4);
        expect(row.transcript).toBe('recorded');
      }
      expect(r.restGet.totalMessages).toBe(4);
      expect(r.mcpGet.totalMessages).toBe(4);
    });

    it(`${kind}: a session that recorded nothing yet reads 0, a real zero distinct from not-recorded`, async () => {
      const w = await seedWorld();
      const id = await insertSession(w, kind, [], { status: 'idle' });
      const r = await readEverywhere(w, id);

      for (const row of [r.restList, r.crossList, r.restGet, r.mcpList, r.mcpGet]) {
        expect(row.messageCount).toBe(0);
        expect(row.transcript).toBe('recorded');
      }
      expect(r.restGet.totalMessages).toBe(0);
      expect(r.mcpGet.totalMessages).toBe(0);
    });
  }

  it('a session from before the ledger reads its transcript length, and keeps it after new entries reach the writer', async () => {
    const w = await seedWorld();
    const legacy = transcriptOf(3);
    const id = await insertSession(w, 'chat', legacy);

    const before = await readEverywhere(w, id);
    for (const row of [
      before.restList,
      before.crossList,
      before.restGet,
      before.mcpList,
      before.mcpGet,
    ]) {
      expect(row.messageCount).toBe(3);
      expect(row.transcript).toBe('recorded');
    }

    const grown = [...legacy, say('user', 3), say('assistant', 4)];
    await harness.db.execute(
      sql`UPDATE agent_sessions SET messages = ${JSON.stringify(grown)}::jsonb WHERE id = ${id}::uuid`,
    );
    await writeLedger(id, legacy, grown);
    const ledgerRows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM agent_session_turns WHERE agent_session_id = ${id}::uuid`,
    );
    expect((ledgerRows[0] as { n: number }).n).toBe(2);

    const after = await readEverywhere(w, id);
    for (const row of [
      after.restList,
      after.crossList,
      after.restGet,
      after.mcpList,
      after.mcpGet,
    ]) {
      expect(row.messageCount).toBe(5);
    }
    expect(after.restGet.totalMessages).toBe(5);
    expect(after.mcpGet.totalMessages).toBe(5);
  });
});

describe('a transcript longer than its ledger reads the transcript on every surface', () => {
  for (const kind of ['chat', 'pipeline'] as const) {
    it(`${kind}: 324 transcript entries with 1 ledger row read 324 on the list and the detail alike`, async () => {
      const w = await seedWorld();
      const messages = transcriptOf(324);
      const id = await insertSession(w, kind, messages);
      await writeLedger(id, [], messages.slice(0, 1));
      const ledgerRows = await harness.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM agent_session_turns WHERE agent_session_id = ${id}::uuid`,
      );
      expect((ledgerRows[0] as { n: number }).n).toBe(1);

      const r = await readEverywhere(w, id);
      for (const row of [r.restList, r.crossList, r.restGet, r.mcpList, r.mcpGet]) {
        expect(row.messageCount).toBe(324);
        expect(row.transcript).toBe('recorded');
      }
      expect(r.restGet.totalMessages).toBe(324);
      expect(r.mcpGet.totalMessages).toBe(324);
    });
  }

  it('a ledger that is behind by one entry does not hold the count one short', async () => {
    const w = await seedWorld();
    const messages = transcriptOf(10);
    const id = await insertSession(w, 'chat', messages);
    await writeLedger(id, [], messages.slice(0, 9));

    const r = await readEverywhere(w, id);
    for (const row of [r.restList, r.crossList, r.restGet, r.mcpList, r.mcpGet]) {
      expect(row.messageCount).toBe(10);
    }
  });
});

describe('the two counts agree', () => {
  it('on every lane the detail reads one number for messageCount and totalMessages', async () => {
    const w = await seedWorld();
    const ids = {
      master: await insertSession(w, 'master', []),
      run_session: await insertSession(w, 'run_session', []),
      chat: await insertSession(w, 'chat', transcriptOf(2)),
      pipeline: await insertSession(w, 'pipeline', []),
    };
    await writeLedger(ids.chat, [], transcriptOf(2));
    for (const id of Object.values(ids)) {
      const row = await viaRestGet(w, id);
      expect(row.messageCount).toBe(row.totalMessages);
    }
  });
});
