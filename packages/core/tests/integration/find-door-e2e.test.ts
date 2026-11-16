/**
 * ISS-1256 criterion 4, against real Postgres: one search door. The owner asked what "run slots" are
 * called and nothing could answer. Here the glossary term Run slots carries the Vietnamese alias
 * "chia slot", is placed in Execution › devices and anchored at `devices/run-slots.ts:slotsFor`; its
 * title and text never say "chia". A find for "chia slot" answers it first, with its path, through
 * the REST find and `forge_find` in the same ranks; opening it answers its relations and counts the
 * read on the box's run; a find matching nothing is kept as a gap the gaps read shows.
 *
 * The embedder is a stand-in (`helpers/word-vector.ts:modelLikeVector`) with the live model's spread,
 * every text half-similar to every other: what this proves is the door's read path — the alias
 * expansion, the fusion, the dense floor and the shape — not the model's grasp of a paraphrase.
 *
 * @direct-test-of packages/core/src/find/service.ts
 * @direct-test-of packages/core/src/find/routes.ts
 * @direct-test-of packages/core/src/find/open.ts
 * @direct-test-of packages/core/src/find/gaps.ts
 * @direct-test-of packages/core/src/find/model-reads.ts
 * @direct-test-of packages/core/src/find/arms-records.ts
 * @direct-test-of packages/core/src/find/arms-memory.ts
 * @direct-test-of packages/core/src/find/arms-shared.ts
 * @direct-test-of packages/core/src/mcp/find-records.ts
 * @direct-test-of packages/core/src/run-context/record.ts
 * @direct-test-of packages/core/src/lib/search-fusion.ts
 * @direct-test-of packages/core/src/labels/module-map-nodes.ts
 */

import type { FindGapsView, FindOpened, FindResult } from '@forge/contracts/find';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { env } from '../../src/lib/env.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestFeedback,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';
import { modelLikeVector, vectorAt } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => modelLikeVector(text),
  embedQuery: async (_s: unknown, text: string) => modelLikeVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(modelLikeVector),
}));

const ANCHOR = 'packages/core/src/devices/run-slots.ts:slotsFor';
const w = { projectId: '', owner: '', token: '', pat: '', pane: '', termId: '', deviceId: '' };

async function knowledge(
  kind: string,
  slug: string,
  title: string,
  body: string,
  extra: { term?: unknown; moduleId?: string } = {},
): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, embedding, entry_type, term, module_id)
    VALUES (${w.projectId}, ${kind}, ${slug}, ${title}, ${body},
            ${`[${modelLikeVector(`${title}\n\n${body}`).join(',')}]`}::vector, 'convention',
            ${extra.term ? JSON.stringify(extra.term) : null}::jsonb, ${extra.moduleId ?? null})
    RETURNING id`);
  return row?.id as string;
}

async function moduleLabel(name: string, slug: string, parentId: string | null): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`
    INSERT INTO labels (project_id, name, color, kind, slug, parent_id)
    VALUES (${w.projectId}, ${name}, '#1f6f4a', 'module', ${slug}, ${parentId}) RETURNING id`);
  return row?.id as string;
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
      name: 'find',
      projectIds: [project.id],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;

  const execution = await moduleLabel('Execution', 'execution', null);
  const devices = await moduleLabel('Devices', 'devices', execution);
  // named after the code module `schedules/`, so the schedule cards sit under Execution on the map
  await moduleLabel('schedules', 'schedules', execution);
  w.termId = await knowledge(
    'glossary',
    'run-slots',
    'Run slots',
    'How Forge shares the runs a runner box may hold at once between the projects that have work.',
    {
      term: {
        aliases: { vi: ['chia slot'], code: ['slotsFor'], industry: ['fair-share scheduling'] },
        namedBy: { who: 'owner', quote: 'chia slot' },
      },
      moduleId: devices,
    },
  );
  const rule = await knowledge(
    'rule',
    'one-slot-minimum',
    'A project with work keeps at least one slot',
    'Every project with open work holds at least one run slot; free slots go to the busiest.',
    { moduleId: execution },
  );
  // a rule holding the query's own word "slot", unplaced, which a keyword arm ranks too
  await knowledge(
    'rule',
    'release-slot',
    'Release slot',
    'The slot of a release train is Tuesday.',
  );
  for (const [kind, toType, toRef] of [
    ['used_in', 'rule', 'one-slot-minimum'],
    ['anchored_at', 'code', ANCHOR],
  ] as const) {
    await db.execute(sql`
      INSERT INTO knowledge_relations (project_id, from_entry_id, kind, to_type, to_ref, written_agency)
      VALUES (${w.projectId}, ${w.termId}, ${kind}, ${toType}, ${toRef}, 'agent')`);
  }
  await db.execute(sql`
    INSERT INTO knowledge_relations (project_id, from_entry_id, kind, to_type, to_ref, written_agency)
    VALUES (${w.projectId}, ${rule}, 'governs', 'capability', 'run declare', 'agent')`);
  // the org's ruling on the same subject: every project's, so no project's module or Unplaced row
  await db.execute(sql`
    INSERT INTO org_knowledge_entries (org_id, slug, title, body, injection)
    VALUES ((SELECT org_id FROM projects WHERE id = ${w.projectId}), 'tuesday-trains',
            'Trains leave on Tuesday', 'Every release train of the org leaves on a Tuesday.', 'always')`);
  // a lesson's own title is its number; its gist is the sentence it is read by
  await knowledge(
    'lesson',
    'lesson-7',
    'L-7',
    'Keep empty states to one or two words. Test them served.',
  );
  const issue = await createTestIssue(w.projectId, owner.id, 1245, {
    status: 'open',
    createdAt: new Date(),
  });
  await db.execute(
    sql`UPDATE issues SET title = 'Run slots are set by prose caps' WHERE id = ${issue.id}`,
  );

  const box = await pairTestBox(w.projectId, { pairedBy: owner.id, actsAs: owner.id });
  w.deviceId = box.deviceId;
  w.pane = box.paneToken as string;
  await createTestRunSession(w.projectId, box.deviceId, new Date(), null);
});

/**
 * An issue whose memory copy sits at exactly `cosine` to `query`'s vector. Its title and text share
 * no word with the query, so only the memory arm's dense read can find it.
 */
async function issueCopyAt(seq: number, query: string, cosine: number): Promise<string> {
  const issue = await createTestIssue(w.projectId, w.owner, seq, {
    status: 'open',
    createdAt: new Date(),
  });
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
    VALUES (${w.projectId}, 'issue', ${issue.id}, ${`issue ${seq}`}, ${vectorAt(query, cosine, seq)}::vector)`);
  return issue.key;
}

/**
 * A feedback item whose stored vector sits at exactly `cosine` to `query`'s. Its title and body share
 * no word with the query, so only the feedback arm's dense read can find it.
 */
async function feedbackAt(seq: number, query: string, cosine: number): Promise<string> {
  const key = await createTestFeedback(w.projectId, w.owner, seq);
  await db.execute(sql`
    INSERT INTO item_embeddings (project_id, feedback_id, version, model, embedding, content_hash, status)
    SELECT ${w.projectId}, id, 1, ${env.EMBEDDINGS_MODEL}, ${vectorAt(query, cosine, seq)}::vector, 'h', 'embedded'
    FROM feedback WHERE project_id = ${w.projectId} AND fb_seq = ${seq}`);
  return key;
}

async function find(query: Record<string, unknown>, token = w.token): Promise<FindResult> {
  const res = await api(token, 'POST', `/api/projects/${w.projectId}/find`, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as FindResult;
}

async function mcp(name: string, args: Record<string, unknown>) {
  const res = await api(
    w.pat,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const text = (res.body as { result: { content: { text: string }[] } }).result.content[0]?.text;
  return JSON.parse(text ?? '{}') as Body;
}

const flat = (r: FindResult) => r.groups.flatMap((g) => g.hits);

describe('criterion 4: "chia slot" finds the term Run slots first, with its path', () => {
  it('answers the term first over REST, matched by its Vietnamese alias, in Execution › Terms', async () => {
    const found = await find({ q: 'chia slot' });
    const [top] = flat(found);
    expect(top).toMatchObject({
      id: `term:${w.termId}`,
      type: 'term',
      key: 'run-slots',
      title: 'Run slots',
      path: ['Execution', 'Terms'],
      module: { slug: 'execution', name: 'Execution', path: 'execution/devices' },
      match: { alias: 'chia slot' },
    });
    expect(found.groups[0]?.type).toBe('term');
    expect(found.expanded).toEqual([{ term: 'Run slots', alias: 'chia slot', termId: w.termId }]);
    expect(found.gap).toBe(false);
    // the query expanded to the term's title, so the rule and the issue naming slots are found too
    expect(flat(found).map((h) => h.key)).toEqual(
      expect.arrayContaining(['one-slot-minimum', 'ISS-1245']),
    );
  });

  it('answers forge_find in the same ranks, beside the actions', async () => {
    const rest = flat(await find({ q: 'chia slot' })).map((h) => h.id);
    const agent = await mcp('forge_find', { query: 'chia slot', projectId: w.projectId });
    expect((agent.records as { id: string }[]).map((h) => h.id)).toEqual(rest);
    expect((agent.records as Body[])[0]).toMatchObject({ path: ['Execution', 'Terms'] });
    expect(Array.isArray(agent.actions)).toBe(true);
  });

  it('facets by type, module and status, and filters by each', async () => {
    const found = await find({ q: 'chia slot' });
    expect(found.facets.module).toEqual(
      expect.arrayContaining([
        { value: 'execution', label: 'Execution', count: 2 },
        expect.objectContaining({ value: 'unplaced' }),
      ]),
    );
    const placed = await find({ q: 'chia slot', module: ['execution'] });
    expect(flat(placed).map((h) => h.key)).toEqual(['run-slots', 'one-slot-minimum']);
    const issues = await find({ q: 'chia slot', type: ['issue'], status: ['open'] });
    expect(flat(issues).map((h) => h.type)).toEqual(['issue']);
  });

  it('opens the hit with its relations, and refuses an id naming nothing by name', async () => {
    const res = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/find/open?id=${encodeURIComponent(`term:${w.termId}`)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const opened = res.body as unknown as FindOpened;
    expect(opened.hit.path).toEqual(['Execution', 'Terms']);
    expect(opened.relations).toEqual(
      expect.arrayContaining([
        { kind: 'anchored_at', direction: 'out', type: 'code', ref: ANCHOR },
        { kind: 'used_in', direction: 'out', type: 'rule', ref: 'one-slot-minimum' },
      ]),
    );
    const bad = await api(w.token, 'GET', `/api/projects/${w.projectId}/find/open?id=term:nope`);
    expect(JSON.stringify(bad.body)).toMatch(/FIND_HIT_ID_INVALID/);
    const gone = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/find/open?id=term:00000000-0000-4000-8000-000000000000`,
    );
    expect(JSON.stringify(gone.body)).toMatch(/FIND_HIT_NOT_FOUND/);
  });

  it("counts an agent's open as a read of the term on its run", async () => {
    const res = await api(
      w.pane,
      'GET',
      `/api/projects/${w.projectId}/find/open?id=${encodeURIComponent(`term:${w.termId}`)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(
      async () => {
        const reached = await rows<{ ref: string; how: string }>(sql`
          SELECT ref, how FROM run_context_reaches WHERE project_id = ${w.projectId}`);
        expect(reached).toContainEqual({ ref: 'run-slots', how: 'get' });
      },
      { timeout: 5000 },
    );
  });
});

describe('criterion 4: a capability hit is pathed where the module map places it', () => {
  it("places a card in the module its door's code lives in, on the find and on its open", async () => {
    const card = 'POST /api/schedules/:id/run';
    const found = await find({
      q: 'fires a schedule once now outside its cron',
      type: ['capability'],
    });
    const hit = flat(found).find((h) => h.ref === card);
    const placed = {
      path: ['Execution', 'Capabilities'],
      module: { slug: 'execution', name: 'Execution', path: 'execution/schedules' },
    };
    expect(hit, 'the schedule card was not found').toBeDefined();
    expect(hit, 'a capability hit is unplaced although its card names a module').toMatchObject(
      placed,
    );
    const res = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/find/open?id=${encodeURIComponent(`capability:${card}`)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as unknown as FindOpened).hit).toMatchObject(placed);
    // the map's Capabilities branch holds the same card under the same module
    const branch = await api(w.token, 'GET', `/api/projects/${w.projectId}/modules/execution/map`);
    expect(JSON.stringify(branch.body)).toContain(card);
  });
});

describe('criterion 4: a hit reads as the map reads it', () => {
  it("counts the project's unplaced rules as the pillar does, the org's ruling in a row of its own", async () => {
    const found = await find({ q: 'release train tuesday slot', type: ['rule'] });
    const byKey = new Map(flat(found).map((h) => [h.key, h]));
    expect(byKey.get('tuesday-trains')?.path).toEqual(['Org', 'Rules']);
    expect(byKey.get('release-slot')?.path).toEqual(['Unplaced', 'Rules']);
    const pillar = await api(w.token, 'GET', `/api/projects/${w.projectId}/modules/map`);
    const unplacedRules = (pillar.body as { unplaced: { counts: { rule: number } } }).unplaced
      .counts.rule;
    const facet = found.facets.module.find((f) => f.value === 'unplaced');
    expect(facet?.count, "search's Unplaced rules differ from the pillar's").toBe(unplacedRules);
    expect(found.facets.module).toContainEqual({ value: 'org', label: 'Org', count: 1 });
  });

  it('names a lesson by its gist, on the find and on its open', async () => {
    const [lesson] = flat(await find({ q: 'empty states words', type: ['lesson'] }));
    expect(lesson).toMatchObject({
      key: 'lesson-7',
      title: 'Keep empty states to one or two words.',
    });
    const res = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/find/open?id=${encodeURIComponent(lesson?.id ?? '')}`,
    );
    expect((res.body as unknown as FindOpened).hit.title).toBe(
      'Keep empty states to one or two words.',
    );
  });
});

describe('criterion 4: a find with no hit is a gap', () => {
  it('answers nonsense with no hit although every dense arm has a nearest row', async () => {
    // a short issue's copy sits above SEMANTIC_FLOOR to token soup, as dropped judge-test issues
    // did live (0.561 to "zzqx flarn vobble"), and stays under the memory arm's own floor
    await issueCopyAt(1301, 'qzxv wbrlt plimbo', 0.57);
    // words the stand-in hashes onto no seeded word's dimension, so nothing here shares one
    const missed = await find({ q: 'qzxv wbrlt plimbo' });
    expect(
      missed,
      'an issue copy under ISSUE_SEMANTIC_FLOOR counted as a match in the memory arm',
    ).toMatchObject({
      gap: true,
      total: 0,
      groups: [],
    });
  });

  it('still finds an issue a narrow real query leads at 0.62, as "run slots" did live', async () => {
    const key = await issueCopyAt(1302, 'gobbet narwhal', 0.62);
    const found = await find({ q: 'gobbet narwhal' });
    expect(found.gap).toBe(false);
    expect(flat(found).map((h) => h.key)).toContain(key);
  });

  it('answers nonsense with no hit although a short feedback item sits at 0.57 to it', async () => {
    // feedback similar measured live: "zzqx flarn vobble" led FB-289 at 0.552, "lorem ipsum dolor"
    // at 0.562; a narrow literal query at 0.57 is the keyword arm's to find, never the dense one's
    await feedbackAt(1311, 'vrombit quazzle', 0.57);
    const missed = await find({ q: 'vrombit quazzle' });
    expect(
      missed,
      'a feedback item under ITEM_SEMANTIC_FLOOR counted as a match in the item arm',
    ).toMatchObject({ gap: true, total: 0, groups: [] });
  });

  it('still finds a feedback item a real paraphrase leads at 0.64, as live ones did', async () => {
    const key = await feedbackAt(1312, 'snorkel teapot', 0.64);
    const found = await find({ q: 'snorkel teapot' });
    expect(found.gap).toBe(false);
    expect(flat(found).map((h) => h.key)).toContain(key);
  });

  it("finds a narrow literal query's feedback by its words, under the item floor", async () => {
    // "run slots" led its feedback at 0.575 live: the keyword arm carries it, not the dense one
    const key = await feedbackAt(1313, 'plover', 0.575);
    await db.execute(sql`
      UPDATE feedback SET title = 'plover cramp on the board' WHERE project_id = ${w.projectId} AND fb_seq = 1313`);
    const hit = flat(await find({ q: 'plover' })).find((h) => h.key === key);
    expect(hit, 'the feedback naming the query was not found').toBeDefined();
    expect(hit?.match.arms).toEqual(['keyword']);
  });

  it('records the miss and shows it in the gaps read, most asked first', async () => {
    const missed = await find({ q: 'zzqx vortigaunt' });
    expect(missed).toMatchObject({ gap: true, total: 0, groups: [] });
    await find({ q: 'Zzqx Vortigaunt' });
    await vi.waitFor(
      async () => {
        const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/find/gaps`);
        const gaps = (res.body as unknown as FindGapsView).gaps;
        expect(gaps[0]).toMatchObject({ query: 'zzqx vortigaunt', searches: 2, lastBy: 'person' });
      },
      { timeout: 5000 },
    );
    expect((await find({ q: 'chia slot' })).gap).toBe(false);
  });
});
