// ISS-790: "if an entry is ever replaced, that fact is recorded somewhere a
// person can find". After ISS-876 deleted the dedup absorb — and with it
// `archiveSupersededText`, the only thing that had ever recorded a replacement
// — an exact-key re-write was the one remaining path by which a memory's text
// replaces another's, and it left no trace. The four wrong-day rows repaired on
// 2026-09-05 were recoverable only because the deleted absorb had left archived
// snapshots behind; a repeat would have had nothing to read.

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const DIM = 1536;

interface RevisionRow {
  memoryId: string;
  source: string;
  sourceRef: string;
  textContent: string;
  replacedAt: string;
}

describe('a replaced memory body is recorded (ISS-790)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    const { memoryWriteRoutes } = await import('../../src/memory/write-routes.js');
    const { memoryListRoutes } = await import('../../src/memory/list-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memoryWriteRoutes);
    app.route('/api/memory', memoryListRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const one = new Array<number>(DIM).fill(0);
    one[7] = 1;
    embeddingsMod.resetEmbeddingsClient({
      embed: vi.fn(async () => one),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => one)),
      resetBreaker: () => undefined,
    } as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>);
  });

  async function seedMember(): Promise<{ projectId: string; token: string }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    return { projectId: project.id, token: await signUserToken(user.id) };
  }

  function write(
    token: string,
    projectId: string,
    sourceRef: string,
    textContent: string,
    source = 'note',
  ) {
    return app.request('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, source, sourceRef, textContent }),
    });
  }

  async function revisions(
    token: string,
    query: string,
  ): Promise<{
    items: RevisionRow[];
    total: number;
  }> {
    const res = await app.request(`/api/memory/revisions?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { items: RevisionRow[]; total: number };
  }

  // cm:guard the exact-key re-write is the path BOTH agent preambles instruct ("reusing a `sourceRef` refines the existing note"), so this is the routine write, not an edge case — before ISS-790 the previous body left no trace anywhere in Forge
  it('keeps the body an exact-key re-write replaced, while recall returns the new one', async () => {
    const { projectId, token } = await seedMember();
    const first = '## Dream Run — 2026-09-04\n\nSix bullets, the 09-04 findings.';
    const second = '## Dream Run — 2026-09-05\n\nSix bullets, the 09-05 findings.';

    expect((await write(token, projectId, 'dream-daily-review', first)).status).toBe(201);
    expect((await write(token, projectId, 'dream-daily-review', second)).status).toBe(201);

    const live = await app.request(
      `/api/memory?projectId=${projectId}&source=note&sourceRef=dream-daily-review`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const liveRows = ((await live.json()) as { items: Array<{ textContent: string }> }).items;
    expect(liveRows.map((r) => r.textContent)).toEqual([second]);

    const { items, total } = await revisions(
      token,
      `projectId=${projectId}&sourceRef=dream-daily-review`,
    );
    expect(total).toBe(1);
    expect(items[0]?.textContent).toBe(first);
    expect(items[0]?.sourceRef).toBe('dream-daily-review');
    expect(items[0]?.source).toBe('note');
  });

  // cm:guard the embedding backfill and `feedback verdict=confirmed` both UPDATE a memory row without touching its text; a revision minted there would make the history stop meaning "someone replaced this"
  it('records nothing when the text did not change', async () => {
    const { projectId, token } = await seedMember();
    const body = 'one wording, written twice';
    await write(token, projectId, 'stable-ref', body);
    await write(token, projectId, 'stable-ref', body);

    await harness.db.execute(
      sql`UPDATE memories SET last_verified_at = now() WHERE project_id = ${projectId}`,
    );

    expect((await revisions(token, `projectId=${projectId}`)).total).toBe(0);
  });

  it('records nothing for a write under a ref that did not exist (ISS-876 stays true)', async () => {
    const { projectId, token } = await seedMember();
    await write(token, projectId, 'ref-a', 'the A wording');
    await write(token, projectId, 'ref-b', 'the B wording');

    const rows = await harness.db.execute(
      sql`SELECT source_ref FROM memories WHERE project_id = ${projectId} ORDER BY source_ref`,
    );
    expect(rows.map((r) => r.source_ref)).toEqual(['ref-a', 'ref-b']);
    expect((await revisions(token, `projectId=${projectId}`)).total).toBe(0);
  });

  // cm:guard the trigger's source list is `AGENT_AUTHORED_SOURCES` written in SQL — a lifecycle mirror's row tracks a record that keeps its own history, and recording those would mint a revision on every issue-description save, forever, in a table nobody reads
  it('leaves lifecycle mirrors out of the history', async () => {
    const { projectId, token } = await seedMember();
    await harness.db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content)
      VALUES (${projectId}, 'issue', 'issue:1', 'the first description')
    `);
    await harness.db.execute(sql`
      UPDATE memories SET text_content = 'the edited description'
      WHERE project_id = ${projectId} AND source = 'issue'
    `);

    expect((await revisions(token, `projectId=${projectId}`)).total).toBe(0);
  });

  // cm:guard the trap the sibling list route shipped: `zValidator` STRIPS a filter the query schema never declared, so the response counts the whole store while reading as a match unless the caller checks `total`
  it('filters to the ref asked for, and counts only that ref', async () => {
    const { projectId, token } = await seedMember();
    await write(token, projectId, 'keep-me', 'first');
    await write(token, projectId, 'keep-me', 'second');
    await write(token, projectId, 'other-1', 'first');
    await write(token, projectId, 'other-1', 'second');

    const scoped = await revisions(token, `projectId=${projectId}&sourceRef=keep-me`);
    expect(scoped.total).toBe(1);
    expect(scoped.items.map((r) => r.sourceRef)).toEqual(['keep-me']);

    expect((await revisions(token, `projectId=${projectId}`)).total).toBe(2);
  });

  it('orders a ref with several replacements newest first', async () => {
    const { projectId, token } = await seedMember();
    for (const body of ['v1', 'v2', 'v3']) {
      await write(token, projectId, 'churned', body);
    }

    const { items, total } = await revisions(token, `projectId=${projectId}&sourceRef=churned`);
    expect(total).toBe(2);
    expect(items.map((r) => r.textContent)).toEqual(['v2', 'v1']);
  });
});
