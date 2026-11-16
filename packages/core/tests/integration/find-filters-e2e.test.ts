/**
 * ISS-1256 criterion 5, against real Postgres: every search that is not the find door is a filter of
 * it. For one query each folded door answers exactly what `POST /api/projects/:id/find` answers for
 * the same types, in the same order: the issue list's text filter, knowledge search, memory search,
 * MCP `search`, the home's search and a room's transcript search. The judge saw `issues/search`
 * answer 2 issues for "run slots" where find's issue filter answered 21; here an issue whose words
 * never say "run slots", found by its copy's meaning alone, is listed by both.
 *
 * The embedder is a stand-in (`helpers/word-vector.ts:modelLikeVector`) with the live model's spread.
 *
 * @direct-test-of packages/core/src/find/recall-filter.ts
 * @direct-test-of packages/core/src/find/memory-filter.ts
 * @direct-test-of packages/core/src/find/issue-filter.ts
 * @direct-test-of packages/core/src/find/transcript-filter.ts
 * @direct-test-of packages/core/src/issues/list-service.ts
 * @direct-test-of packages/core/src/issues/search.ts
 * @direct-test-of packages/core/src/knowledge/routes.ts
 * @direct-test-of packages/core/src/memory/search-routes.ts
 * @direct-test-of packages/core/src/memory/find-port.ts
 * @direct-test-of packages/core/src/mcp/records-search.ts
 * @direct-test-of packages/core/src/product-progress/home-find.ts
 * @direct-test-of packages/core/src/assistant/tools/transcript-search-tool.ts
 */

import type { FindHit, FindResult, FindType } from '@forge/contracts/find';
import { HOME_FIND_LIMIT } from '@forge/contracts/owner-home';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildTranscriptSearchToolset,
  TRANSCRIPT_SEARCH_TOOL_NAME,
} from '../../src/assistant/tools/transcript-search-tool.js';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { modelLikeVector, vectorAt } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => modelLikeVector(text),
  embedQuery: async (_s: unknown, text: string) => modelLikeVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(modelLikeVector),
}));

const Q = 'run slots';
const w = { projectId: '', owner: '', token: '', pat: '', meaningOnly: '', room: '' };

async function knowledge(kind: string, slug: string, title: string, body: string, term?: unknown) {
  await db.execute(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, embedding, entry_type, term)
    VALUES (${w.projectId}, ${kind}, ${slug}, ${title}, ${body},
            ${`[${modelLikeVector(`${title}\n\n${body}`).join(',')}]`}::vector, 'convention',
            ${term ? JSON.stringify(term) : null}::jsonb)`);
}

async function note(ref: string, text: string, embedding = `[${modelLikeVector(text).join(',')}]`) {
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    VALUES (${w.projectId}, 'note', ${ref}, ${text}, ${embedding}::vector)`);
}

async function titled(seq: number, title: string): Promise<{ id: string; key: string }> {
  const issue = await createTestIssue(w.projectId, w.owner, seq, {
    status: 'open',
    createdAt: new Date(Date.now() - seq * 1000),
  });
  await db.execute(sql`UPDATE issues SET title = ${title} WHERE id = ${issue.id}`);
  return issue;
}

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  const project = await createTestProject(owner.id);
  await addProjectMember(project.id, owner.id, 'owner');
  w.projectId = project.id;
  w.owner = owner.id;
  w.token = await userToken(owner.id);
  w.pat = (
    await mintPat({
      permissions: ['*'],
      userId: owner.id,
      name: 'filters',
      projectIds: [project.id],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;

  await knowledge(
    'glossary',
    'run-slots',
    'Run slots',
    'How Forge shares the runs a runner box may hold at once between projects.',
    { aliases: { vi: ['chia slot'] }, namedBy: { who: 'owner', quote: 'chia slot' } },
  );
  await knowledge(
    'rule',
    'one-slot-minimum',
    'A project with work keeps at least one slot',
    'Every project with open work holds at least one run slot; free slots go to the busiest.',
  );
  await knowledge(
    'lesson',
    'lesson-9',
    'L-9',
    'Wait for a free run slot before you dispatch more.',
  );
  await knowledge('guide', 'slot-guide', 'Slots guide', 'How the runs of a box are shared.');

  await note('slot-note', 'A run slot freed by a crashed pane is reclaimed after ten minutes.');
  await note('slot-note-2', 'Run slots per box are set by the runner config, never by prose.');
  // a note whose words never say the query, near it by meaning alone
  await note('meaning-note', 'the pane reclaim timer', vectorAt(Q, 0.64, 41));

  // the issue a substring finds, and the issues only the door's meaning finds
  await titled(2001, 'Run slots are set by prose caps');
  await titled(2002, 'Run slots starve a quiet project');
  const quiet = await titled(2003, 'the pane timer forgets its box');
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    VALUES (${w.projectId}, 'issue', ${quiet.id}, 'the pane timer forgets its box', ${vectorAt(Q, 0.66, 7)}::vector)`);
  w.meaningOnly = quiet.key;
  await createTestFeedback(w.projectId, w.owner, 2011);
  await db.execute(sql`
    UPDATE feedback SET title = 'run slots never free up' WHERE project_id = ${w.projectId} AND fb_seq = 2011`);
});

async function find(types: FindType[], limit: number, extra: Record<string, unknown> = {}) {
  const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/find`, {
    q: Q,
    type: types,
    limit,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body as unknown as FindResult;
  // the door's own order across its groups: by fused score, as the filters read it
  return result.groups.flatMap((g) => g.hits).sort((a, b) => b.score - a.score);
}

const refs = (hits: readonly FindHit[]) => hits.map((h) => h.ref);

/**
 * `folded` is the door's order: the same records, and at each place a record the door ranks at the
 * same fused score (two hits of different types can tie, and the door's groups do not say which of a
 * tie came first). `key` names a door hit as the folded door names it.
 */
function expectDoorOrder(
  folded: readonly string[],
  door: readonly FindHit[],
  key: (h: FindHit) => string,
  what: string,
) {
  const scoreOf = new Map(door.map((h) => [key(h), h.score]));
  expect([...folded].sort(), `${what} answers other records than the find door`).toEqual(
    door.map(key).sort(),
  );
  expect(
    folded.map((id) => scoreOf.get(id)),
    `${what} ranks apart from the find door`,
  ).toEqual(door.map((h) => h.score));
}

describe('criterion 5: the issue list text filter is the find door issue filter', () => {
  it('lists for "run slots" exactly the issues find keeps, in its order, the one found by meaning included', async () => {
    const door = await find(['issue'], 50);
    expect(door.map((h) => h.key)).toContain(w.meaningOnly);
    const res = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/issues/search?q=${encodeURIComponent(Q)}&limit=50`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const listed = (res.body.items as { id: string }[]).map((r) => r.id);
    expect(listed, 'issues/search ranks or matches apart from the find door').toEqual(refs(door));
    // the list route's own `search` reads the same filter
    const plain = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/issues?search=${encodeURIComponent(Q)}&limit=50`,
    );
    expect((plain.body.items as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [...refs(door)].sort(),
    );
  });

  it('orders the same set by a sort sent beside the words', async () => {
    const door = await find(['issue'], 50);
    const res = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/issues/search?q=${encodeURIComponent(Q)}&sort=createdAt:asc`,
    );
    const listed = (res.body.items as { id: string }[]).map((r) => r.id);
    expect([...listed].sort()).toEqual([...refs(door)].sort());
  });
});

describe('criterion 5: knowledge search is the find door knowledge filter', () => {
  it('answers the knowledge find keeps, in its order', async () => {
    const door = await find(['term', 'rule', 'lesson', 'knowledge'], 5);
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
      query: Q,
      topK: 5,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const recalled = (res.body.knowledge as { id: string; origin: string }[]).map((h) =>
      h.origin === 'org' ? `org:${h.id}` : h.id,
    );
    expectDoorOrder(recalled, door, (h) => h.ref, 'knowledge/search');
    expect(recalled.length).toBeGreaterThan(1);
  });

  it('refuses a strategy by name: the door ranks every search one way', async () => {
    const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
      query: Q,
      strategy: 'keyword',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/strategy[\s\S]*find door/);
  });
});

describe('criterion 5: memory search is the find door memory filter', () => {
  it('answers the memory find keeps, in its order, the note found by meaning included', async () => {
    const door = await find(['memory', 'decision'], 5);
    const res = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: Q,
      topK: 5,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const hits = res.body.hits as { id: string; sourceRef: string; standing: string }[];
    expectDoorOrder(
      hits.map((h) => h.id),
      door,
      (h) => h.ref,
      'memory/search',
    );
    expect(hits.map((h) => h.sourceRef)).toContain('meaning-note');
    expect(hits[0]?.standing).toBeDefined();
  });

  it('refuses a mirror source by name, pointing at where issues are found', async () => {
    const res = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: Q,
      sourceFilter: ['issue'],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/find[\s\S]*issue/);
  });
});

describe('criterion 5: MCP search and the home search are filters of the door', () => {
  it('MCP search answers the records find keeps for its types, in its order', async () => {
    const searched: FindType[] = ['issue', 'requirement', 'term', 'rule', 'lesson', 'knowledge'];
    const door = await find(searched, 24);
    const res = await api(
      w.pat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: Q } },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const text = (res.body as { result: { content: { text: string }[] } }).result.content[0]?.text;
    const results = (JSON.parse(text ?? '{}') as Body).results as { id: string }[];
    const idOf = (h: FindHit) =>
      h.ref.startsWith('org:')
        ? h.ref
        : h.type === 'issue' || h.type === 'requirement'
          ? `${h.type}:${h.ref}`
          : `knowledge:${h.ref}`;
    expectDoorOrder(
      results.map((r) => r.id),
      door,
      idOf,
      'MCP search',
    );
  });

  it("the home's search answers the issues and feedback find keeps, in its order", async () => {
    const door = await find(['issue', 'feedback'], HOME_FIND_LIMIT);
    const res = await api(w.token, 'GET', `/api/me/home/find?q=${encodeURIComponent(Q)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.items as { key: string }[];
    expectDoorOrder(
      items.map((i) => i.key),
      door,
      (h) => h.key ?? '',
      "the home's search",
    );
  });
});

describe("criterion 5: a room's transcript search is the door's conversation filter", () => {
  beforeAll(async () => {
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'slots',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    w.room = String(opened.body.id);
    for (const [seq, text] of [
      [0, 'we talked about run slots on the big box'],
      [2, 'the run slots went to the busy project again'],
      [4, 'lunch at noon'],
    ] as const) {
      await db.execute(sql`
        INSERT INTO conversation_passages (conversation_id, first_seq, last_seq, last_offset, message_count, started_at, ended_at, text)
        VALUES (${w.room}, ${seq}, ${seq + 1}, ${text.length}, 2, now(), now(), ${text})`);
    }
  });

  it('answers the passages find keeps for the room, in its order, with its coverage', async () => {
    const door = await find(['conversation'], 5, { conversation: w.room });
    const tool = buildTranscriptSearchToolset({
      conversationId: w.room,
      projectId: w.projectId,
      principalUserId: w.owner,
    });
    const out = await tool.execute(
      TRANSCRIPT_SEARCH_TOOL_NAME,
      JSON.stringify({ query: Q, limit: 5 }),
    );
    const read = JSON.parse((out.content[0] as { text: string }).text) as {
      matches: { passageId: string }[];
      coverage: unknown;
    };
    expect(read.matches.map((m) => m.passageId)).toEqual(refs(door));
    expect(read.matches).toHaveLength(2);
    expect(read.coverage).toBeDefined();
    const [held] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM conversation_passages WHERE conversation_id = ${w.room}`);
    expect(held?.n).toBe(3);
  });
});
