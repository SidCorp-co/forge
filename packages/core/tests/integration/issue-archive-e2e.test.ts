/**
 * ISS-1237 end to end, against real Postgres and the whole app on a socket.
 *
 * The fixture is the complaint: a closed issue a search returns today. It is planted beside a
 * control that the same search also matches and that is never archived, so "the archived row is
 * gone" cannot be read off a search that simply stopped matching. Unarchiving at the end brings
 * every surface back, which is what shows the archive flag — and nothing else — was the cause.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

const DIM = 1536;
const TERM = 'staged pipeline clarify';

function vectorFor(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  v[(seed * 7 + 3) % DIM] = 0.5;
  return v;
}
const vec = (seed: number) => `[${vectorFor(seed).join(',')}]`;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let adminId: string;
let adminToken: string;
let memberToken: string;
let adminPat: string;
let writerPat: string;
let memberPat: string;
const id: Record<string, string> = {};
const memoryId: Record<string, string> = {};

let search: typeof import('../../src/memory/search.js');
let expandIssueRelations: typeof import('../../src/memory/expand-relations.js').expandIssueRelations;
let runMemoryGet: typeof import('../../src/memory/get-service.js').runMemoryGet;
let readPmGraph: typeof import('../../src/pm/graph-service.js').readPmGraph;
let parseSseStream: typeof import('../../src/assistant/providers/sse.js').parseSseStream;

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${init.token ?? adminToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const archive = (direction: 'archive' | 'unarchive', body: unknown, token?: string) =>
  api(`/api/projects/${projectId}/issues/${direction}`, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(token ? { token } : {}),
  });

async function seedIssue(seq: number, key: string, title: string, status: string, vecSeed: number) {
  const issueId = randomUUID();
  const merged = status === 'closed' ? sql`now()` : sql`NULL`;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, created_by_id, merged_at, created_at)
    VALUES (${issueId}, ${projectId}, ${seq}, ${title}, ${`body of ${title}`}, ${status}, ${adminId},
            ${merged}, now() + ${`${seq} seconds`}::interval)`);
  const rows = (await harness.db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    VALUES (${projectId}, 'issue', ${issueId}, ${title}, ${vec(vecSeed)}::vector) RETURNING id`)) as unknown as {
    id: string;
  }[];
  id[key] = issueId;
  memoryId[key] = rows[0]?.id ?? '';
}

async function edge(from: string, to: string, kind: string, expired = false) {
  const until = expired ? sql`now() - interval '1 day'` : sql`NULL`;
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind, valid_until)
    VALUES (${projectId}, ${id[from]}, ${id[to]}, ${kind}, ${until})`);
}

async function archivedAt(key: string): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT archived_at::text AS at FROM issues WHERE id = ${id[key]}`,
  )) as unknown as { at: string | null }[];
  return rows[0]?.at ?? null;
}

async function streamIds(path: string): Promise<string[]> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const out: string[] = [];
  for await (const data of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
    const f = JSON.parse(data) as {
      type: string;
      id?: string;
      issueId?: string;
      hits?: { sourceRef: string }[];
    };
    if (f.type !== 'item') continue;
    out.push(f.issueId ?? f.id ?? '');
    for (const h of f.hits ?? []) out.push(h.sourceRef);
  }
  return out;
}

async function mcp(pat: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({
      name: 'forge_issues',
      arguments: { projectId, ...args },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    if (res.isError) return { error: res.content[0]?.text ?? '' };
    return { value: parseToolResult(res) as Record<string, unknown> };
  } finally {
    await ctx.close();
  }
}

const docIds = (r: { value?: Record<string, unknown> }) =>
  ((r.value?.issues ?? []) as { documentId: string }[]).map((i) => i.documentId);
const refs = (hits: { sourceRef: string }[]) => hits.map((h) => h.sourceRef);
const neighbourHit = () => ({
  id: memoryId.neighbour ?? '',
  source: 'issue' as const,
  sourceRef: id.neighbour ?? '',
  text: '',
  metadata: {},
  score: 1,
  embeddedAt: new Date(),
  stale: false,
});
const memoryList = () =>
  runMemoryGet({
    projectId,
    source: 'issue',
    limit: 50,
    offset: 0,
    orderBy: 'createdAt',
    orderDir: 'desc',
  });

const itemIds = (body: Record<string, unknown>) =>
  ((body.items ?? body.data ?? []) as { id: string }[]).map((r) => r.id);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.EMBEDDINGS_BASE_URL ??= 'http://embeddings.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'test-key';
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  const embeddings = await import('../../src/embeddings/index.js');
  search = await import('../../src/memory/search.js');
  ({ expandIssueRelations } = await import('../../src/memory/expand-relations.js'));
  ({ runMemoryGet } = await import('../../src/memory/get-service.js'));
  ({ readPmGraph } = await import('../../src/pm/graph-service.js'));
  ({ parseSseStream } = await import('../../src/assistant/providers/sse.js'));
  server = await startTestServer();
  await truncateAll(harness.db);

  const admin = await createTestUser(harness.db);
  const member = await createTestUser(harness.db);
  adminId = admin.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (await createTestProject(harness.db, adminId)).id;
  await createTestProjectMember(harness.db, { userId: adminId, projectId, role: 'admin' });
  await createTestProjectMember(harness.db, { userId: member.id, projectId, role: 'member' });
  adminToken = await signUserToken(adminId);
  memberToken = await signUserToken(member.id);
  const allScopes = ['read', 'write', 'admin'];
  adminPat = (await mintPat({ userId: adminId, name: 'admin', scopes: allScopes })).plaintext;
  writerPat = (await mintPat({ userId: adminId, name: 'writer' })).plaintext;
  memberPat = (await mintPat({ userId: member.id, name: 'member', scopes: allScopes })).plaintext;

  // `open3`'s title embeds to `old`'s vector, so before archiving `old` is its nearest neighbour.
  const titles = new Map([['Planned rewrite of the clarify handoff', 1]]);
  embeddings.resetEmbeddingsClient({
    embed: async (t: string) => vectorFor(titles.get(t) ?? 99),
    embedBatch: async (ts: string[]) => ts.map((t) => vectorFor(titles.get(t) ?? 99)),
  } as unknown as Parameters<typeof embeddings.resetEmbeddingsClient>[0]);

  await seedIssue(1, 'old', `Legacy ${TERM} step`, 'closed', 1);
  await seedIssue(2, 'control', `Current ${TERM} replacement`, 'closed', 2);
  await seedIssue(3, 'open3', 'Planned rewrite of the clarify handoff', 'open', 3);
  await seedIssue(4, 'loadBearing', 'Closed but related to open work', 'closed', 4);
  await seedIssue(5, 'pairA', 'Closed pair A', 'closed', 5);
  await seedIssue(6, 'pairB', 'Closed pair B', 'dropped', 6);
  await seedIssue(7, 'expired', 'Closed with an expired edge', 'closed', 7);
  await seedIssue(8, 'neighbour', 'Closed neighbour of the legacy one', 'closed', 8);
  await edge('open3', 'loadBearing', 'relates');
  await edge('pairA', 'pairB', 'blocks');
  await edge('open3', 'expired', 'blocks', true);
  await edge('neighbour', 'old', 'relates');
  await harness.db.execute(sql`
    UPDATE memories SET chunked_at = now(), chunk_generation = 1 WHERE id = ${memoryId.old}`);
  await harness.db.execute(sql`
    INSERT INTO memory_chunks (memory_id, chunk_index, text_content, context_prefix, embedding, generation)
    VALUES (${memoryId.old}, 0, ${`Legacy ${TERM} step`}, 'ISS-1', ${vec(1)}::vector, 1)`);
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

const q = encodeURIComponent(TERM);

describe('the column and the fixture, before anything is archived', () => {
  it('adds a nullable, indexed archived_at by a migration that writes no row', async () => {
    const cols = (await harness.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'issues' AND column_name = 'archived_at'`)) as unknown as {
      is_nullable: string;
    }[];
    expect(cols).toEqual([{ is_nullable: 'YES' }]);
    const idx = (await harness.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = 'issues_archived_at_idx'`,
    )) as unknown as unknown[];
    expect(idx).toHaveLength(1);
    const ddl = readFileSync(
      new URL('../../drizzle/migrations/0308_issues_archived_at.sql', import.meta.url),
      'utf8',
    );
    expect(ddl).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE)\b/i);
  });

  it('reproduces the complaint: the search returns the old closed issue and the control', async () => {
    const res = await api(`/api/projects/${projectId}/issues/search?q=${q}`);
    expect(itemIds(res.body)).toEqual(expect.arrayContaining([id.old, id.control]));
  });

  it('shows the old issue on every other surface too, so its absence later is the flag and not the fixture', async () => {
    const appended = await expandIssueRelations({ projectId, hits: [neighbourHit()], topK: 5 });
    expect(refs(appended)).toContain(id.old);
    const listed = await memoryList();
    expect(refs(listed.rows)).toContain(id.old);
    expect((await readPmGraph({ projectId, depth: 2 })).nodes).toHaveLength(8);
    const alike = await streamIds(`/api/projects/${projectId}/backlog/alike?status=open&topK=10`);
    expect(alike).toContain(id.old);
    const ordering = await streamIds(`/api/projects/${projectId}/backlog/ordering?status=closed`);
    expect(ordering).toContain(id.old);
    for (const memoryModel of ['flat', 'chunked'] as const) {
      const base = { projectId, topK: 20, query: TERM, memoryModel };
      expect(refs(await search.keywordSearchMemories(base))).toContain(id.old);
    }
  });

  it('a dry run answers the intersection minus exclude, names the keys it left out, and writes nothing', async () => {
    const res = await archive('archive', {
      filter: {
        keys: ['ISS-1', 'ISS-2', 'ISS-3'],
        statuses: ['closed'],
        seqBelow: 3,
        exclude: ['ISS-2'],
      },
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      matched: ['ISS-1'],
      unmatchedKeys: ['ISS-2', 'ISS-3'],
      changed: ['ISS-1'],
      refusals: [],
    });
    expect(await archivedAt('old')).toBeNull();
  });
});

describe('what an archive refuses, writing nothing', () => {
  it('refuses a key the project does not hold, in keys or in exclude, naming it', async () => {
    for (const filter of [{ keys: ['ISS-999'] }, { statuses: ['closed'], exclude: ['ISS-998'] }]) {
      const res = await archive('archive', { filter });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/ISS-99[89]/);
    }
    expect(await archivedAt('old')).toBeNull();
  });

  it('refuses a non-terminal issue, naming it and its status', async () => {
    const res = await archive('archive', { filter: { keys: ['ISS-1', 'ISS-3'] } });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('ISS-3 is `open`');
    expect(await archivedAt('old')).toBeNull();
  });

  it('refuses an issue a live edge ties to unfinished work, naming the edge kind and the other issue', async () => {
    const res = await archive('archive', { filter: { keys: ['ISS-1', 'ISS-4'] } });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(
      /ISS-4 is still load-bearing: .*ISS-4 ← relates from ISS-3, which is `open`/,
    );
    expect(await archivedAt('old')).toBeNull();
    expect(await archivedAt('loadBearing')).toBeNull();
  });

  it('refuses a caller below project admin, on REST and on MCP', async () => {
    const rest = await archive(
      'archive',
      { filter: { keys: ['ISS-1'] }, dryRun: true },
      memberToken,
    );
    expect(rest.status).toBe(403);
    const ask = { action: 'archive', archiveFilter: { keys: ['ISS-1'] }, dryRun: true };
    expect((await mcp(writerPat, ask)).error).toMatch(/lacks the admin scope/);
    expect((await mcp(memberPat, ask)).error).toMatch(/requires project admin access/);
  });

  it('answers the same report over MCP as over REST', async () => {
    const body = { keys: ['ISS-1', 'ISS-2'], statuses: ['closed'] };
    const rest = await archive('archive', { filter: body, dryRun: true });
    const viaMcp = await mcp(adminPat, { action: 'archive', archiveFilter: body, dryRun: true });
    expect(viaMcp.value).toEqual(rest.body);
  });
});

describe('archiving', () => {
  it('archives a terminal pair and a row whose only edge expired', async () => {
    const res = await archive('archive', { filter: { keys: ['ISS-5', 'ISS-6', 'ISS-7'] } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(['ISS-5', 'ISS-6', 'ISS-7']);
  });

  it('archives once, answers what it changed, and keeps the first stamp on a second call', async () => {
    const first = await archive('archive', { filter: { keys: ['ISS-1'] } });
    expect(first.body).toMatchObject({ changed: ['ISS-1'], unchanged: [] });
    const stamp = await archivedAt('old');
    expect(stamp).not.toBeNull();
    const second = await archive('archive', { filter: { keys: ['ISS-1'] } });
    expect(second.body).toMatchObject({ changed: [], unchanged: ['ISS-1'] });
    expect(await archivedAt('old')).toBe(stamp);
  });
});

describe('an archived issue is out of discovery', () => {
  it('leaves the search, which still returns the control, unless asked for', async () => {
    const res = await api(`/api/projects/${projectId}/issues/search?q=${q}`);
    expect(itemIds(res.body)).toContain(id.control);
    expect(itemIds(res.body)).not.toContain(id.old);
    const all = await api(`/api/projects/${projectId}/issues/search?q=${q}&includeArchived=true`);
    expect(itemIds(all.body)).toContain(id.old);
  });

  it('leaves the list rows and its total unless asked for', async () => {
    const res = await api(`/api/projects/${projectId}/issues?limit=100`);
    expect(itemIds(res.body)).not.toContain(id.old);
    expect(res.body.total).toBe(4);
    const all = await api(`/api/projects/${projectId}/issues?limit=100&includeArchived=true`);
    expect(all.body.total).toBe(8);
  });

  it('leaves the MCP browse unless filters.includeArchived', async () => {
    const plain = await mcp(adminPat, { action: 'list', filters: { status: 'closed' } });
    expect(docIds(plain)).toContain(id.control);
    expect(docIds(plain)).not.toContain(id.old);
    const filters = { status: 'closed', includeArchived: true };
    expect(docIds(await mcp(adminPat, { action: 'list', filters }))).toContain(id.old);
  });

  it('leaves every memory search arm, flat and chunked', async () => {
    for (const memoryModel of ['flat', 'chunked'] as const) {
      const base = { projectId, topK: 20, memoryModel };
      const semantic = await search.searchMemories({ ...base, queryVec: vectorFor(1) });
      const keyword = await search.keywordSearchMemories({ ...base, query: TERM });
      const hybrid = await search.hybridSearchMemories({
        ...base,
        queryVec: vectorFor(1),
        query: TERM,
      });
      for (const hits of [semantic, keyword, hybrid.hits]) expect(refs(hits)).not.toContain(id.old);
      expect(refs(keyword)).toContain(id.control);
    }
  });

  it('leaves relation expansion, the memory list, and the whole-project graph', async () => {
    const appended = await expandIssueRelations({ projectId, hits: [neighbourHit()], topK: 5 });
    expect(refs(appended)).not.toContain(id.old);
    const listed = await memoryList();
    expect(refs(listed.rows)).not.toContain(id.old);
    const graph = await readPmGraph({ projectId, depth: 2 });
    expect(graph.nodes.map((n) => n.id)).not.toContain(id.old);
    expect(graph.nodes).toHaveLength(4);
  });

  it('leaves the alike stream as a neighbour and as a seed, and the ordering stream', async () => {
    const alike = await streamIds(
      `/api/projects/${projectId}/backlog/alike?status=open,closed&topK=10`,
    );
    expect(alike).toContain(id.open3);
    expect(alike).not.toContain(id.old);
    const ordering = await streamIds(`/api/projects/${projectId}/backlog/ordering?status=closed`);
    expect(ordering).toContain(id.control);
    expect(ordering).not.toContain(id.old);
  });
});

describe('an archived issue still answers by key, and refuses becoming load-bearing', () => {
  it('answers the list by key, by display id, by id, and forge_issues get, each with archivedAt', async () => {
    const byKey = await api(`/api/projects/${projectId}/issues?key=ISS-1`);
    expect((byKey.body.items as { archivedAt: string | null }[])[0]?.archivedAt).not.toBeNull();
    const byDisplay = await api(`/api/projects/${projectId}/issues/by-display/ISS-1`);
    const byId = await api(`/api/issues/${id.old}`);
    for (const body of [byDisplay.body, byId.body]) expect(body.archivedAt).not.toBeNull();
    const got = await mcp(adminPat, { action: 'get', documentId: id.old });
    expect(got.value?.archivedAt).not.toBeNull();
  });

  it('refuses a transition with ISSUE_ARCHIVED naming the unarchive route, and the status stays', async () => {
    const res = await api(`/api/issues/${id.old}/transition`, {
      method: 'POST',
      body: JSON.stringify({ toStatus: 'open', reason: 'try to reopen an archived one' }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ISSUE_ARCHIVED' });
    expect(res.body.message).toContain(`/api/projects/${projectId}/issues/unarchive`);
    const rows = (await harness.db.execute(
      sql`SELECT status FROM issues WHERE id = ${id.old}`,
    )) as unknown as { status: string }[];
    expect(rows[0]?.status).toBe('closed');
  });

  it('refuses a new edge naming it on either end, and still lets an existing edge be retracted', async () => {
    const onto = await api(`/api/issues/${id.control}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ dependsOnId: id.old, kind: 'relates' }),
    });
    const from = await api(`/api/issues/${id.old}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ dependsOnId: id.control, kind: 'relates' }),
    });
    for (const res of [onto, from]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'ISSUE_ARCHIVED' });
      expect(res.body.message).toContain('ISS-1 is archived');
    }
    const retract = await api(`/api/issues/${id.old}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({
        dependsOnId: id.neighbour,
        kind: 'relates',
        validUntil: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    expect(retract.status).toBeLessThan(300);
  });
});

describe('unarchiving brings every surface back', () => {
  it('clears the stamp, answers what it touched, and the search and memory return it again', async () => {
    const res = await archive('unarchive', { filter: { keys: ['ISS-1'] } });
    expect(res.body).toMatchObject({ changed: ['ISS-1'], unchanged: [] });
    expect(await archivedAt('old')).toBeNull();
    const again = await archive('unarchive', { filter: { keys: ['ISS-1'] } });
    expect(again.body).toMatchObject({ changed: [], unchanged: ['ISS-1'] });

    const found = await api(`/api/projects/${projectId}/issues/search?q=${q}`);
    expect(itemIds(found.body)).toContain(id.old);
    const semantic = await search.searchMemories({ projectId, topK: 20, queryVec: vectorFor(1) });
    expect(semantic.map((h) => h.sourceRef)).toContain(id.old);
    const chunked = await search.keywordSearchMemories({
      projectId,
      topK: 20,
      query: TERM,
      memoryModel: 'chunked',
    });
    expect(chunked.map((h) => h.sourceRef)).toContain(id.old);
  });
});
