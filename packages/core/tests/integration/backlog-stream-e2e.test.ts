/**
 * ISS-1173 end to end: a whole-backlog question costs one round trip, over a real socket.
 *
 * The round-trip figure is MEASURED rather than asserted from the design — the test drives the
 * loop the CLI spends today against the same backlog and counts both, so "one call, not N" is a
 * number this file produces rather than a claim it repeats.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const DIM = 1536;

/** A deterministic unit vector per seed, so cosine order is a property of the text and repeatable. */
function vectorFor(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  v[(seed * 7 + 3) % DIM] = 0.5;
  return v;
}

let harness: TestDatabase;
let server: TestServer;
let embeddingsMod: typeof import('../../src/embeddings/index.js');
let parseSseStream: typeof import('../../src/assistant/providers/sse.js').parseSseStream;
let signUserToken: (id: string) => Promise<string>;

// Read off the code rather than copied, so a page size that moves moves these cases with it. They
// are imported in `beforeAll` for the reason every other module here is: importing the sources
// pulls in `db/client.js`, which validates the environment the harness has not written yet.
let ORDERING_PAGE_SIZE: number;
let EMBED_BATCH_SIZE: number;

let userId: string;
let projectId: string;
let token: string;

/** Every HTTP request this file makes, so a round-trip count is observed rather than assumed. */
let roundTrips = 0;
async function call(path: string, init: RequestInit = {}) {
  roundTrips += 1;
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** Reads a stream to its terminal frame. `stopAfter` aborts mid-answer, as a client that has seen enough does. */
async function readStream(
  path: string,
  opts: { stopAfter?: number } = {},
): Promise<{ frames: Frame[]; aborted: boolean }> {
  const controller = new AbortController();
  const res = await call(path, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');

  const frames: Frame[] = [];
  let items = 0;
  try {
    for await (const data of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
      const frame = JSON.parse(data) as Frame;
      frames.push(frame);
      if (frame.type === 'item') items += 1;
      if (opts.stopAfter !== undefined && items >= opts.stopAfter) {
        controller.abort();
        return { frames, aborted: true };
      }
    }
  } catch {
    return { frames, aborted: true };
  }
  return { frames, aborted: false };
}

const itemsOf = (frames: Frame[]) => frames.filter((f) => f.type === 'item');
const terminalOf = (frames: Frame[]) =>
  frames.filter((f) => f.type === 'end' || f.type === 'error');

async function seedIssue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, created_by_id, created_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`backlog subject ${seq}`},
            ${`body of ${seq}`}, ${status}, ${userId}, now() + ${`${seq} seconds`}::interval)
  `);
  await harness.db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    VALUES (${projectId}, 'issue', ${id}, ${`backlog subject ${seq}`},
            ${`[${vectorFor(seq).join(',')}]`}::vector)
  `);
  return id;
}

/**
 * `count` issues in one statement, cheap enough to cross a page boundary, and every one of them
 * carrying sub-millisecond digits on `created_at`. Those digits are the whole subject: a cursor
 * that truncates them re-reads the boundary row, and `now()` supplies them only by luck.
 *
 * `tiedFrom` gives every issue from that seq onward one identical `created_at`, which is how a
 * page boundary is made to land on an exact tie; `from` moves the whole run to another era.
 */
async function seedIssuesPastBoundary(
  count: number,
  opts: { tiedFrom?: number; from?: string } = {},
) {
  const tiedFrom = opts.tiedFrom ?? count + 1;
  const from = opts.from ?? "timestamptz '2026-01-01 00:00:00+00'";
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, created_by_id, created_at)
    SELECT gen_random_uuid(), ${projectId}, s, 'backlog subject ' || s, 'body of ' || s,
           'open', ${userId},
           ${sql.raw(from)}
             + (least(s, ${tiedFrom}::int) || ' seconds')::interval
             + interval '456 microseconds'
    FROM generate_series(1, ${count}::int) AS s
  `);
  await harness.db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    SELECT ${projectId}, 'issue', i.id, i.title, ${`[${vectorFor(0).join(',')}]`}::vector
    FROM issues i WHERE i.project_id = ${projectId}
  `);
}

/** What a caller counts: how many item frames arrived, and how many distinct issues they named. */
function itemCensus(frames: Frame[]) {
  const items = itemsOf(frames);
  const ids = new Set(items.map((f) => (f.issueId ?? f.id) as string));
  return { emitted: items.length, distinct: ids.size };
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.EMBEDDINGS_BASE_URL ??= 'http://embeddings.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'test-key';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ parseSseStream } = await import('../../src/assistant/providers/sse.js'));
  embeddingsMod = await import('../../src/embeddings/index.js');
  ({ ORDERING_PAGE_SIZE } = await import('../../src/issues/backlog/ordering-source.js'));
  ({ EMBED_BATCH_SIZE } = await import('../../src/issues/backlog/alike-source.js'));
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  roundTrips = 0;

  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  userId = user.id;
  const project = await createTestProject(harness.db, user.id);
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
  token = await signUserToken(userId);

  // The seed's own title embeds to the vector its memories row holds, so a seed is its own
  // nearest neighbour and the ordering of the rest is a fact about the fixture.
  const titled = new Map<string, number>();
  for (let seq = 1; seq <= 12; seq++) titled.set(`backlog subject ${seq}`, seq);
  embeddingsMod.resetEmbeddingsClient({
    embed: async (text: string) => vectorFor(titled.get(text) ?? 0),
    embedBatch: async (texts: string[]) => texts.map((t) => vectorFor(titled.get(t) ?? 0)),
  } as unknown as Parameters<typeof embeddingsMod.resetEmbeddingsClient>[0]);
});

describe('the ordering endpoint', () => {
  it('answers a whole backlog in one round trip, where the loop spends two per issue', async () => {
    const ids: string[] = [];
    for (let seq = 1; seq <= 12; seq++) ids.push(await seedIssue(seq));

    // What the CLI spends today: forge_issues.get with fields:["relations"] is two GETs per
    // candidate — the issue and its dependencies — issued together, once per candidate.
    roundTrips = 0;
    for (const id of ids) {
      await Promise.all([call(`/api/issues/${id}`), call(`/api/issues/${id}/dependencies`)]);
    }
    const loopRoundTrips = roundTrips;

    roundTrips = 0;
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const streamRoundTrips = roundTrips;

    expect(loopRoundTrips).toBe(24);
    expect(streamRoundTrips).toBe(1);
    expect(itemsOf(frames)).toHaveLength(12);
  });

  it('opens with meta, numbers items from one, and ends complete', async () => {
    for (let seq = 1; seq <= 3; seq++) await seedIssue(seq);
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);

    expect(frames[0]).toMatchObject({ type: 'meta', kind: 'ordering', total: 3 });
    expect(itemsOf(frames).map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(terminalOf(frames)).toEqual([
      { type: 'end', complete: true, truncated: false, truncatedBy: null, emitted: 3, total: 3 },
    ]);
  });

  it('carries the relations a ranking reads, and no rank of its own', async () => {
    const blocker = await seedIssue(1);
    const blocked = await seedIssue(2);
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${randomUUID()}, ${projectId}, ${blocker}, ${blocked}, 'blocks')
    `);

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const first = itemsOf(frames).find((f) => f.issueId === undefined && f.id === blocker);

    expect(first).toBeDefined();
    const rel = (first as unknown as { relations: { blocks: unknown[] } }).relations;
    expect(rel.blocks).toHaveLength(1);
    for (const item of itemsOf(frames)) {
      expect(item).not.toHaveProperty('score');
      expect(item).not.toHaveProperty('rank');
      expect(item).not.toHaveProperty('position');
    }
  });

  // The contract lists exactly these, so a column the source reads for its own purposes — the
  // paging cursor, say — reaching an item is a break a reader can see and this case names.
  const ORDERING_ITEM_KEYS = [
    'assigneeId',
    'category',
    'complexity',
    'createdAt',
    'displayId',
    'id',
    'issSeq',
    'mergedAt',
    'mergedCommitSha',
    'priority',
    'relations',
    'reopenCount',
    'seq',
    'status',
    'title',
    'type',
    'updatedAt',
    'waitingKind',
  ];

  it('carries the fields the contract lists and no other, in both body modes', async () => {
    for (let seq = 1; seq <= 3; seq++) await seedIssue(seq);
    const without = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const withBody = await readStream(`/api/projects/${projectId}/backlog/ordering?body=true`);

    for (const item of itemsOf(without.frames)) {
      expect(Object.keys(item).sort()).toEqual(ORDERING_ITEM_KEYS);
    }
    const withBodyKeys = [
      ...ORDERING_ITEM_KEYS,
      'acceptanceCriteria',
      'description',
      'plan',
    ].sort();
    for (const item of itemsOf(withBody.frames)) {
      expect(Object.keys(item).sort()).toEqual(withBodyKeys);
    }
  });

  it('leaves the body off unless it is asked for, because those are the heavy columns', async () => {
    await seedIssue(1);
    const without = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const withBody = await readStream(`/api/projects/${projectId}/backlog/ordering?body=true`);

    expect(itemsOf(without.frames)[0]).not.toHaveProperty('description');
    expect(itemsOf(withBody.frames)[0]).toMatchObject({ description: 'body of 1' });
  });

  it('says it is truncated when work remained behind the bound', async () => {
    for (let seq = 1; seq <= 5; seq++) await seedIssue(seq);
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering?limit=3`);

    expect(itemsOf(frames)).toHaveLength(3);
    expect(terminalOf(frames)[0]).toMatchObject({
      type: 'end',
      complete: false,
      truncated: true,
      truncatedBy: 'items',
    });
  });

  it('says it is complete when the bound and the backlog end together', async () => {
    for (let seq = 1; seq <= 3; seq++) await seedIssue(seq);
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering?limit=3`);

    expect(terminalOf(frames)[0]).toMatchObject({ type: 'end', complete: true, truncated: false });
  });

  it('tells an empty backlog apart from a stream that died', async () => {
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);

    expect(frames[0]).toMatchObject({ type: 'meta', total: 0 });
    expect(itemsOf(frames)).toHaveLength(0);
    expect(terminalOf(frames)[0]).toMatchObject({ type: 'end', complete: true, emitted: 0 });
  });
});

describe('the alike endpoint', () => {
  it('answers a whole sweep in one round trip, where the loop spends one search per issue', async () => {
    for (let seq = 1; seq <= 12; seq++) await seedIssue(seq);

    roundTrips = 0;
    for (let seq = 1; seq <= 12; seq++) {
      await call('/api/memory/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          query: `backlog subject ${seq}`,
          topK: 10,
          strategy: 'semantic',
          sourceFilter: ['issue'],
        }),
      });
    }
    const loopRoundTrips = roundTrips;

    roundTrips = 0;
    const { frames } = await readStream(`/api/projects/${projectId}/backlog/alike`);
    const streamRoundTrips = roundTrips;

    expect(loopRoundTrips).toBe(12);
    expect(streamRoundTrips).toBe(1);
    expect(itemsOf(frames)).toHaveLength(12);
  });

  it('streams the same score the existing search route returns for that seed', async () => {
    for (let seq = 1; seq <= 4; seq++) await seedIssue(seq);

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/alike?topK=4`);
    const streamed = itemsOf(frames).find((f) => f.title === 'backlog subject 2');
    expect(streamed).toBeDefined();

    const res = await call('/api/memory/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        query: 'backlog subject 2',
        topK: 4,
        strategy: 'semantic',
        sourceFilter: ['issue'],
      }),
    });
    const route = (await res.json()) as { hits: Array<{ sourceRef: string; score: number }> };
    const hits = (streamed as unknown as { hits: Array<{ sourceRef: string; score: number }> })
      .hits;

    expect(hits.map((h) => h.sourceRef)).toEqual(route.hits.map((h) => h.sourceRef));
    expect(hits.map((h) => h.score)).toEqual(route.hits.map((h) => h.score));
  });

  it('stops searching once the client has gone', async () => {
    for (let seq = 1; seq <= 12; seq++) await seedIssue(seq);

    const searches = async () => {
      const [row] = await harness.db.execute(sql`
        SELECT count(*)::int AS n FROM retrieval_analytics WHERE project_id = ${projectId}
      `);
      return Number((row as { n: number }).n);
    };

    const { aborted } = await readStream(`/api/projects/${projectId}/backlog/alike`, {
      stopAfter: 2,
    });
    expect(aborted).toBe(true);

    // The analytics row is written off a detached microtask, and the contract lets work already in
    // flight finish, so the count is read once it has stopped moving rather than at the abort.
    let settled = -1;
    await vi.waitFor(
      async () => {
        const now = await searches();
        const stable = now > 0 && now === settled;
        settled = now;
        expect(stable).toBe(true);
      },
      { timeout: 10_000, interval: 500 },
    );

    // All twelve seeds sit in one embedding batch, so a sweep that did not check cancellation
    // before each search would have logged twelve. Stopping leaves the two answered and the one
    // that was already running.
    expect(settled).toBeGreaterThanOrEqual(2);
    expect(settled).toBeLessThanOrEqual(5);
  });
});

describe('what one streamed request costs', () => {
  it('charges its bucket once, however many reads it does inside', async () => {
    for (let seq = 1; seq <= 12; seq++) await seedIssue(seq);
    const res = await call(`/api/projects/${projectId}/backlog/ordering`);
    await res.text();

    const limit = Number(res.headers.get('X-RateLimit-Limit'));
    const remaining = Number(res.headers.get('X-RateLimit-Remaining'));
    expect(limit - remaining).toBe(1);
  });
});

/**
 * ISS-1173, judged at production a594f28eb: 1226 item frames over 1214 issues, one duplicate at
 * every multiple of the page size, and an `end` frame whose `emitted` exceeded its own `total`.
 * Every case above seeds twelve issues, so no page boundary was ever crossed and the assertion
 * could not go red. These cross it.
 */
describe('a backlog longer than one page', () => {
  it('emits the ordering page-boundary issue once, not twice', async () => {
    const total = ORDERING_PAGE_SIZE + 1;
    await seedIssuesPastBoundary(total);

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const census = itemCensus(frames);

    expect(census.distinct).toBe(total);
    expect(census.emitted).toBe(total);
    expect(itemsOf(frames).map((f) => f.seq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(terminalOf(frames)[0]).toMatchObject({
      type: 'end',
      complete: true,
      emitted: total,
      total,
    });
  });

  it('emits the alike batch-boundary seed once, not twice', async () => {
    const total = EMBED_BATCH_SIZE + 1;
    await seedIssuesPastBoundary(total);

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/alike?topK=1`);
    const census = itemCensus(frames);

    expect(census.distinct).toBe(total);
    expect(census.emitted).toBe(total);
    expect(terminalOf(frames)[0]).toMatchObject({
      type: 'end',
      complete: true,
      emitted: total,
      total,
    });
  });

  it('pages across an era rather than reading a BC issue as AD', async () => {
    // The cursor is text Postgres writes and Postgres parses back, and a spelling without `BC`
    // reads a BC timestamp as AD — a boundary landing somewhere else entirely.
    const total = ORDERING_PAGE_SIZE + 1;
    await seedIssuesPastBoundary(total, { from: "timestamptz '0100-01-01 00:00:00 BC'" });

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const census = itemCensus(frames);

    expect(census.distinct).toBe(total);
    expect(census.emitted).toBe(total);
  });

  it('refuses an issue whose timestamp no cursor can carry, instead of reporting complete', async () => {
    // `to_char` answers NULL for `infinity`. Paging from that would read no further row and end
    // the stream `complete` over everything behind it, which is the one outcome worse than a
    // duplicate. An infinite timestamp sorts last, so it is a cursor exactly when it closes a full
    // page and work remains — which is exactly when the pager must carry it and cannot. Two such
    // issues put one of them at the boundary with the other still behind it.
    await seedIssuesPastBoundary(ORDERING_PAGE_SIZE + 1);
    await harness.db.execute(sql`
      UPDATE issues SET created_at = 'infinity'::timestamptz
      WHERE project_id = ${projectId} AND iss_seq IN (1, 2)
    `);

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);

    expect(itemsOf(frames)).toHaveLength(ORDERING_PAGE_SIZE);
    expect(terminalOf(frames)).toEqual([
      {
        type: 'error',
        code: 'UNPAGEABLE_TIMESTAMP',
        message: expect.stringContaining('infinite'),
        emitted: ORDERING_PAGE_SIZE,
      },
    ]);
  });

  it('drops neither of two issues sharing the page boundary timestamp exactly', async () => {
    // The two rows either side of the boundary hold one identical `created_at`, so `id` is the
    // only thing separating them. A cursor nudged forward by a millisecond to stop the duplicate
    // would skip the second of them here; an exact one emits each exactly once.
    const total = ORDERING_PAGE_SIZE + 1;
    await seedIssuesPastBoundary(total, { tiedFrom: ORDERING_PAGE_SIZE });

    const { frames } = await readStream(`/api/projects/${projectId}/backlog/ordering`);
    const census = itemCensus(frames);

    expect(census.distinct).toBe(total);
    expect(census.emitted).toBe(total);
  });
});
