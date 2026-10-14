/**
 * ISS-1241 round 3 — a project's agent-session list reads on past its first page.
 *
 * The list stopped at its limit or at the response-size cap with `hasMore: true` and nothing to
 * pass back, so every row beyond the first page of a busy project was out of reach. Each case
 * seeds one project in Postgres and reads it through the REST route and the MCP tool the way a
 * caller must: page one, then only what `nextCursor` hands back, until it is null.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

  const [readMod, patMod, errMod, jwtMod] = await Promise.all([
    import('../../src/agent-sessions/project-read-routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/jwt.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/projects', readMod.agentSessionProjectReadRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});


type Page = {
  sessions: Array<{ id: string }>;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  truncatedBy?: string;
};

type World = { projectId: string; runId: string; token: string; pat: string };

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
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${project.id}::uuid, 'interactive', 'running')
  `);
  return { projectId: project.id, runId, token: await signUserToken(user.id), pat: plaintext };
}

/** `count` chat sessions whose `updated_at` is `stamp(n)`, each carrying `padding` bytes of metadata. */
async function seedSessions(
  w: World,
  count: number,
  stamp: ReturnType<typeof sql>,
  padding = 0,
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (project_id, pipeline_run_id, kind, status, updated_at, metadata)
    SELECT ${w.projectId}::uuid, ${w.runId}::uuid, 'chat', 'completed', ${stamp},
           jsonb_build_object('pad', repeat('x', ${padding}::int))
    FROM generate_series(1, ${count}::int) AS n
  `);
}

/** Every session id of the project in the order the list promises: newest update first, id breaking a tie. */
async function expectedOrder(w: World): Promise<string[]> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    SELECT id FROM agent_sessions WHERE project_id = ${w.projectId}::uuid
    ORDER BY updated_at DESC, id DESC
  `);
  return rows.map((r) => (r as { id: string }).id);
}

const rest = (w: World, query: string) =>
  app.request(`/api/projects/${w.projectId}/agent-sessions?${query}`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });

async function restPage(w: World, limit: number, cursor: string | null): Promise<Page> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set('cursor', cursor);
  const res = await rest(w, q.toString());
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

async function mcpPages(w: World, limit: number): Promise<(cursor: string | null) => Promise<Page>> {
  const ctx = await connectClientAsPat(w.pat);
  closers.push(() => ctx.close());
  return async (cursor) => {
    const res = (await ctx.client.callTool({
      name: 'forge_agent_sessions.list',
      arguments: { projectId: w.projectId, limit, ...(cursor ? { cursor } : {}) },
    })) as never;
    return parseToolResult(res) as Page;
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

/** Page one, then only the cursor each page hands back; every page must keep `hasMore` and `nextCursor` in step. */
async function walk(read: (cursor: string | null) => Promise<Page>) {
  const ids: string[] = [];
  const pages: Page[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 500; i += 1) {
    const page: Page = await read(cursor);
    pages.push(page);
    ids.push(...page.sessions.map((s) => s.id));
    expect(page.hasMore).toBe(page.nextCursor !== null);
    if (page.nextCursor === null) return { ids, pages };
    cursor = page.nextCursor;
  }
  throw new Error('the cursor never reached the end of the project');
}

const AT = sql`timestamptz '2026-10-01 00:00:00+00' + n * interval '1 second'`;

describe('a project with more sessions than the cap reads on past its first page', () => {
  it('205 sessions asked for at the limit cap: page one stops short, the cursor reaches every other row, REST and MCP alike', async () => {
    const w = await seedWorld();
    await seedSessions(w, 205, AT);
    const expected = await expectedOrder(w);

    const first = await restPage(w, 200, null);
    expect(first.returned).toBeLessThan(205);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const viaRest = await walk((c) => restPage(w, 200, c));
    expect(viaRest.pages.length).toBeGreaterThan(1);
    expect(viaRest.ids).toEqual(expected);
    expect(viaRest.pages.at(-1)?.hasMore).toBe(false);

    const viaMcp = await walk(await mcpPages(w, 200));
    expect(viaMcp.ids).toEqual(expected);
  });

  it('a limit of 50 walks five pages and the last one says it is the last', async () => {
    const w = await seedWorld();
    await seedSessions(w, 205, AT);
    const expected = await expectedOrder(w);

    const viaRest = await walk((c) => restPage(w, 50, c));
    expect(viaRest.ids).toEqual(expected);
    expect(viaRest.pages.map((p) => p.returned)).toEqual([50, 50, 50, 50, 5]);
    expect(viaRest.pages.map((p) => p.hasMore)).toEqual([true, true, true, true, false]);
    expect(viaRest.pages.at(-1)?.nextCursor).toBeNull();
  });

  it('a project that fits one page says hasMore false and hands back no cursor', async () => {
    const w = await seedWorld();
    await seedSessions(w, 3, AT);

    const page = await restPage(w, 50, null);
    expect(page.returned).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect((await (await mcpPages(w, 50))(null)).nextCursor).toBeNull();
  });

  it('a project that exactly fills one page does not claim a page that is not there', async () => {
    const w = await seedWorld();
    await seedSessions(w, 10, AT);
    const expected = await expectedOrder(w);

    const viaRest = await walk((c) => restPage(w, 10, c));
    expect(viaRest.pages).toHaveLength(1);
    expect(viaRest.ids).toEqual(expected);
  });
});

describe('the cursor holds where one page boundary falls inside a tie', () => {
  it('rows that share an updated_at, and rows that differ only below the millisecond, are each read once at limit 1', async () => {
    const w = await seedWorld();
    // Two rows a microsecond apart inside one millisecond, then three that share one instant.
    await seedSessions(w, 1, sql`timestamptz '2026-10-01 00:00:10.123456+00'`);
    await seedSessions(w, 1, sql`timestamptz '2026-10-01 00:00:10.123455+00'`);
    await seedSessions(w, 3, sql`timestamptz '2026-10-01 00:00:05+00'`);
    const expected = await expectedOrder(w);
    expect(expected).toHaveLength(5);

    const viaRest = await walk((c) => restPage(w, 1, c));
    expect(viaRest.ids).toEqual(expected);
    expect(new Set(viaRest.ids).size).toBe(5);

    const viaMcp = await walk(await mcpPages(w, 1));
    expect(viaMcp.ids).toEqual(expected);
  });
});

describe('the cursor holds where the response-size cap, not the limit, ends a page', () => {
  it('30 sessions of about 9 KB each are all read through the cursor, none twice and none skipped', async () => {
    const w = await seedWorld();
    await seedSessions(w, 30, AT, 9_000);
    const expected = await expectedOrder(w);

    const viaRest = await walk((c) => restPage(w, 200, c));
    expect(viaRest.pages.length).toBeGreaterThan(1);
    expect(viaRest.pages[0]?.truncatedBy).toBe('response-size');
    expect(viaRest.ids).toEqual(expected);

    const viaMcp = await walk(await mcpPages(w, 200));
    expect(viaMcp.ids).toEqual(expected);
  });
});

describe('a cursor this list did not mint is refused by name', () => {
  const impossibleDay = Buffer.from(
    '2026-02-30T00:00:00.000000Z|3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8',
    'utf8',
  ).toString('base64url');

  it.each([
    ['not a cursor at all', 'not-a-cursor'],
    ['a day the calendar does not have, which Postgres would refuse as a 500', impossibleDay],
  ])('REST answers 400 naming the cursor: %s', async (_why, bad) => {
    const w = await seedWorld();
    await seedSessions(w, 2, AT);

    const res = await rest(w, `cursor=${bad}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('cursor');
  });

  it.each([
    ['not a cursor at all', 'not-a-cursor', 'cursor is not an agent-session cursor'],
    ['a day the calendar does not have', impossibleDay, 'cursor carries no timestamp'],
  ])('the MCP tool refuses naming the cursor and what is wrong with it: %s', async (_why, bad, message) => {
    const w = await seedWorld();
    await seedSessions(w, 2, AT);
    const ctx = await connectClientAsPat(w.pat);
    closers.push(() => ctx.close());

    const res = (await ctx.client.callTool({
      name: 'forge_agent_sessions.list',
      arguments: { projectId: w.projectId, cursor: bad },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain(`cursor: ${message}`);
  });
});
