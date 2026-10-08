import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { MEMORY_EMBEDDING_DIM } from '../../src/db/schema-types.js';
import { reconcileForReleasedIssue } from '../../src/memory/reconcile.js';
import { api, type Body } from '../helpers/api.js';
import { createTestProject } from '../helpers/factories.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';

// MJ-4: memory's upkeep records are bookkeeping — no caller writes one, no search or Memory list
// returns one unless asked by name — and a release flags a memory possibly stale only with a reason.
// Cross-project keys and MJ-6: a key is read in the project the text places it in, never in this
// one by default, and every source is linked.

const VEC = `[${Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1).join(',')}]`;
const llm = { reply: '' };

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fastModelConfigured: () => true,
  callFastModel: async () => llm.reply,
  embed: async () => Array.from({ length: MEMORY_EMBEDDING_DIM }, () => 0.1),
}));

type Entry = Record<string, unknown> & { id: string; sourceRef: string };

async function entries(w: World, query = ''): Promise<Entry[]> {
  const res = await api(w.token, 'GET', `/api/memory/entries?projectId=${w.projectId}${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Entry[];
}

async function seed(w: World, source: string, ref: string, text: string, metadata: object = {}) {
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata, embedding, embedded_at)
    VALUES (${w.projectId}, ${source}, ${ref}, ${text}, ${JSON.stringify(metadata)}::jsonb, ${VEC}::vector, now() - interval '2 days')
    RETURNING id
  `);
  return (row as { id: string }).id;
}

async function search(w: World, body: Body) {
  const res = await api(w.token, 'POST', '/api/memory/search', {
    projectId: w.projectId,
    strategy: 'keyword',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.hits as { sourceRef: string }[]).map((h) => h.sourceRef);
}

describe('bookkeeping is its own kind', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    await seed(
      w,
      'bookkeeping',
      'reconcile:ISS-9',
      'reconcile ISS-9: 0 contradicted, board decided',
      {
        cause: 'memory-reconcile',
      },
    );
    await seed(w, 'decision', 'owner/board', 'The owner decided the board is flat');
  });

  it('refuses a caller writing it', async () => {
    const res = await api(w.token, 'POST', '/api/memory', {
      projectId: w.projectId,
      source: 'bookkeeping',
      sourceRef: 'reconcile:ISS-1',
      textContent: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('is not a decision on the Memory page, and is listed only by name', async () => {
    expect((await entries(w)).map((e) => e.sourceRef)).toEqual(['owner/board']);
    expect((await entries(w, '&sources=decision')).map((e) => e.sourceRef)).toEqual([
      'owner/board',
    ]);
    expect((await entries(w, '&sources=bookkeeping')).map((e) => e.sourceRef)).toEqual([
      'reconcile:ISS-9',
    ]);
  });

  it('is not a search hit unless asked for by name', async () => {
    expect(await search(w, { query: 'board' })).toEqual(['owner/board']);
    expect(await search(w, { query: 'board', sourceFilter: ['bookkeeping'] })).toEqual([
      'reconcile:ISS-9',
    ]);
  });

  it('is not on the Decisions page', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/decisions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('reconcile');
  });
});

describe('a release flags a memory possibly stale only with a reason', () => {
  let w: World;
  let said: string;
  let silent: string;
  let issueId: string;

  beforeAll(async () => {
    w = await world();
    said = await seed(w, 'note', 'gotcha/theme', 'The store theme is 496 on the hop site');
    silent = await seed(w, 'note', 'gotcha/header', 'The header is drawn by the store theme');
    issueId = (await issue(w, { status: 'awaiting_release', createdAt: ago(5), mergedAt: ago(0) }))
      .id;
    llm.reply = JSON.stringify({
      contradicted: [],
      possiblyStale: [
        {
          id: said,
          reason: 'The release moved the site to the served theme, which this note names as 496',
        },
        { id: silent },
      ],
      unaffected: [],
    });
  });

  it('stamps the reason on the row it flags, leaves the reasonless one unflagged, and records both as bookkeeping', async () => {
    const result = await reconcileForReleasedIssue(w.projectId, issueId);
    expect(result.possiblyStale).toBe(1);

    const rows = await entries(w);
    expect(rows.find((r) => r.id === said)?.flagged).toMatchObject({
      by: 'ISS-1',
      reason: 'The release moved the site to the served theme, which this note names as 496',
    });
    expect(rows.find((r) => r.id === silent)?.flagged).toBeNull();

    const kept = await db.execute<{ source: string; metadata: Record<string, unknown> }>(sql`
      SELECT source, metadata FROM memories WHERE project_id = ${w.projectId} AND source_ref = 'reconcile:ISS-1'
    `);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.source).toBe('bookkeeping');
    expect(kept[0]?.metadata.unexplainedRefs).toEqual(['gotcha/header']);
    const decisions = await db.execute(sql`
      SELECT 1 FROM memories WHERE project_id = ${w.projectId} AND source = 'decision'
    `);
    expect(decisions).toHaveLength(0);
  });

  it('runs once per issue: a second reconcile reads its bookkeeping record and stops', async () => {
    expect((await reconcileForReleasedIssue(w.projectId, issueId)).skipped).toBe(
      'already-reconciled',
    );
  });
});

describe('a key is read in the project the memory places it in, and every source links', () => {
  let w: World;
  let sibling: { id: string; slug: string };

  beforeAll(async () => {
    w = await world();
    await issue(w, { status: 'dropped', createdAt: ago(5) }); // this project's ISS-1: dropped
    const [org] = await db.execute<{ org_id: string }>(
      sql`SELECT org_id FROM projects WHERE id = ${w.projectId}`,
    );
    sibling = await createTestProject(w.userId, { orgId: (org as { org_id: string }).org_id });
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (gen_random_uuid(), ${sibling.id}, 1, 'sibling issue', 'open', ${w.userId})
    `);
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, release_version)
      VALUES (gen_random_uuid(), ${w.projectId}, 'system', 'completed', '0.2.0')
    `);
    await seed(
      w,
      'note',
      'gotcha/cross',
      `Fixed by ${sibling.slug} ISS-1 and upstream in core ISS-1 (779e4736a); shipped in 0.2.0, not 0.9.0.`,
    );
  });

  it('checks a named sibling key against the sibling, leaves an unnamed project key unchecked, and links the rest', async () => {
    const row = (await entries(w)).find((r) => r.sourceRef === 'gotcha/cross') as Entry;
    expect(row.cites).toEqual([
      {
        ref: 'ISS-1',
        kind: 'issue',
        project: sibling.slug,
        state: 'resolved',
        changedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      { ref: 'ISS-1', kind: 'issue', project: null, state: 'unchecked' },
      {
        ref: '779e4736a',
        kind: 'commit',
        project: (await slugOf(w.projectId)) as string,
        state: 'unchecked',
      },
      {
        ref: '0.2.0',
        kind: 'release',
        project: (await slugOf(w.projectId)) as string,
        state: 'resolved',
      },
    ]);
    expect(row.staleRefs).toEqual([]);
  });
});

async function slugOf(projectId: string): Promise<string | undefined> {
  const [row] = await db.execute<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${projectId}`,
  );
  return (row as { slug: string } | undefined)?.slug;
}
