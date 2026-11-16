/**
 * REQ-89 (ISS-1121), against real Postgres: memory and knowledge are curated at save time, kept apart
 * from core's logs and copies, and re-checked when the system changes.
 *  - BC-1, BC-4: a write answers value, type, scope and re-check; one leaving an answer out is
 *    stored as a hypothesis, unscoped, warned by name and listed as owing it.
 *  - BC-2: a write on a subject already held updates that entry and keeps the old text; a knowledge
 *    write naming a second slug for it is refused by name unless it says it replaces the first.
 *  - BC-3: an issue copy is never listed, counted or recalled as memory; it is read by name.
 *  - BC-2, recall (ISS-1156): a subject two entries hold is recalled once, by its newest entry.
 *  - BC-5: a landing touching a path an entry names flags the entry; a rule's rewrite flags what
 *    names the rule; a rewrite clears the flag. A temporary entry's ending is
 *    `memory-endings-e2e.test.ts`.
 *
 * The embedder is a stand-in for the model: each distinct word is one dimension, so two texts are as
 * close as the words they share. Same text, same vector: what the near-duplicate rule weighs.
 *
 * @direct-test-of packages/core/src/memory/write-service.ts
 * @direct-test-of packages/core/src/memory/curation.ts
 * @direct-test-of packages/core/src/memory/recheck.ts
 * @direct-test-of packages/core/src/memory/one-per-subject.ts
 * @direct-test-of packages/core/src/memory/search-service.ts
 * @direct-test-of packages/core/src/memory/entries.ts
 * @direct-test-of packages/core/src/memory/get-service.ts
 * @direct-test-of packages/core/src/memory/search.ts
 * @direct-test-of packages/core/src/memory/person-acts.ts
 * @direct-test-of packages/core/src/knowledge/upsert.ts
 * @direct-test-of packages/core/src/knowledge/subject-held.ts
 * @direct-test-of packages/core/src/knowledge/recheck.ts
 * @direct-test-of packages/core/src/issues/memory-reads.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { selectAlwaysInjectFromKnowledge } from '../../src/knowledge/index.js';
import { recheckForLanding } from '../../src/memory/recheck.js';
import { api, type Body } from '../helpers/api.js';
import {
  CURATED,
  entries,
  getKnowledge,
  openCuratedMemoryWorld,
  putKnowledge,
  w,
  write,
} from '../helpers/curated-memory-world.js';
import { wordVector } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => wordVector(text),
  embedQuery: async (_s: unknown, text: string) => wordVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(wordVector),
}));

openCuratedMemoryWorld();

describe('BC-1, BC-4: a write answers its curation, and one leaving it out is warned and owes it', () => {
  it('stores a write with no type as a hypothesis, unscoped, and names each answer it owes', async () => {
    const res = await write({
      source: 'note',
      sourceRef: 'gotcha/uncurated',
      textContent: 'The store theme id lives in the site config table',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body.warnings as { path: string }[]).map((x) => x.path)).toEqual([
      '/value',
      '/type',
      '/scope',
      '/recheckWhen',
    ]);
    const row = ((await entries()).body.items as Body[]).find(
      (e) => e.sourceRef === 'gotcha/uncurated',
    );
    expect(row?.curation).toMatchObject({
      type: 'hypothesis',
      scope: 'unscoped',
      owed: ['value', 'type', 'scope', 'recheckWhen'],
    });
    expect(row?.needsCheck).toContain('uncurated');
  });

  it('keeps a curated write as written, warns nothing, and owes nothing', async () => {
    const res = await write({
      source: 'knowledge',
      sourceRef: 'convention/vector-reuse',
      textContent: 'An unchanged memory text keeps its stored vector on rewrite',
      ...CURATED,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toBeUndefined();
    const row = ((await entries()).body.items as Body[]).find(
      (e) => e.sourceRef === 'convention/vector-reuse',
    );
    expect(row?.curation).toMatchObject({ type: 'fact', owed: [] });
    expect(row?.needsCheck).not.toContain('uncurated');
  });
});

describe('BC-2: a write on a held subject updates that entry', () => {
  it('lands a near-identical write under a new ref on the entry holding it, keeping its old text', async () => {
    await write({
      source: 'note',
      sourceRef: 'gotcha/deploy-wait',
      textContent: 'A push to dev deploys forge dev and the run waits on sourceCommit',
      ...CURATED,
    });
    const again = await write({
      source: 'note',
      sourceRef: 'gotcha/deploy-wait-again',
      textContent: 'A push to dev deploys forge dev and the run waits on the sourceCommit',
      ...CURATED,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.landedOn).toMatchObject({ sourceRef: 'gotcha/deploy-wait' });
    expect((again.body.replaced as { revisionId: string | null }).revisionId).not.toBeNull();
    const refs = ((await entries()).body.items as Body[]).map((e) => e.sourceRef);
    expect(refs).toContain('gotcha/deploy-wait');
    expect(refs).not.toContain('gotcha/deploy-wait-again');
  });

  it('recalls a subject two entries hold once, by its newest entry, naming the other', async () => {
    const first = await write({
      source: 'note',
      sourceRef: 'gotcha/twice-held',
      textContent: 'The runner pane keeps its tmux socket under the checkout path',
      ...CURATED,
    });
    // a second entry of the same subject under another ref, as written before a write joined them
    const [second] = (await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, metadata, embedding, embedded_at, created_at, updated_at)
      SELECT project_id, source, 'gotcha/twice-held-legacy', text_content || ' again', metadata, embedding, embedded_at,
             now() + interval '1 minute', now() + interval '1 minute'
        FROM memories WHERE id = ${first.body.id as string}
      RETURNING id::text AS id`)) as unknown as { id: string }[];
    const recall = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'runner pane tmux socket checkout path',
      topK: 5,
    });
    expect(recall.status, JSON.stringify(recall.body)).toBe(200);
    const held = (recall.body.hits as Body[]).filter((h) =>
      [first.body.id, second?.id].includes(h.id as string),
    );
    expect(held.map((h) => h.id)).toEqual([second?.id]);
    expect(held[0]?.duplicates).toEqual([first.body.id]);
    expect(recall.body.duplicatesFolded).toBeGreaterThanOrEqual(1);
  });

  it('lands a write on the entry `updates` names, and refuses one naming none', async () => {
    const first = await write({
      source: 'note',
      sourceRef: 'gotcha/named',
      textContent: 'The lease outlives the build by three hundred minutes',
      ...CURATED,
    });
    const named = await write({
      source: 'note',
      sourceRef: 'gotcha/other-words',
      textContent: 'Take a lease of five hours so it outlives a long build',
      updates: first.body.id,
      ...CURATED,
    });
    expect(named.body.id).toBe(first.body.id);
    const none = await write({
      source: 'note',
      sourceRef: 'gotcha/x',
      textContent: 'anything',
      updates: 'gotcha/never-written',
    });
    expect(none.status).toBe(404);
    expect(JSON.stringify(none.body)).toContain('MEMORY_NOT_FOUND');
  });

  it('refuses a knowledge entry under a second slug for a held subject, and takes it when it replaces the first', async () => {
    const body = {
      kind: 'rule',
      title: 'Delete by literal path',
      body: 'Every delete names its literal absolute path, never a variable',
      type: 'convention',
      source: 'owner ruling',
      scope: 'every shell delete',
      recheckWhen: 'the rm permission dialog changes',
    };
    expect((await putKnowledge('literal-delete', body)).status).toBe(200);
    const second = await putKnowledge('delete-literally', body);
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain('KNOWLEDGE_SUBJECT_HELD');
    expect(JSON.stringify(second.body)).toContain('literal-delete');
    const replacing = await putKnowledge('delete-literally', {
      ...body,
      replaces: 'literal-delete',
    });
    expect(replacing.status, JSON.stringify(replacing.body)).toBe(200);
    expect(replacing.body.replaced).toBe('literal-delete');
    expect((await getKnowledge('literal-delete')).body.archivedAt).not.toBeNull();
  });

  it('keeps the text a knowledge rewrite replaced, and warns a rule written with no type', async () => {
    const base = {
      kind: 'rule',
      title: 'Pace',
      body: 'One builder at a time unless urgent',
      source: 'owner',
      scope: 'every master',
      recheckWhen: 'the owner rules on pace',
    };
    const first = await putKnowledge('pace-rule', base);
    expect((first.body.warnings as { path: string }[])[0]?.path).toBe('/type');
    await putKnowledge('pace-rule', {
      ...base,
      body: 'One builder at a time; three when urgent',
      type: 'convention',
    });
    const read = await getKnowledge('pace-rule');
    expect(read.body.type).toBe('convention');
    expect((read.body.revisions as { body: string }[]).map((r) => r.body)).toEqual([
      'One builder at a time unless urgent',
    ]);
  });
});

describe('BC-3: an issue copy is history, never memory', () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, metadata)
      VALUES (${w.projectId}, 'issue', gen_random_uuid()::text, 'Copy of an issue about the store theme', '{}'::jsonb)`);
  });

  it('is not listed or counted by the memory list or the entries list', async () => {
    const list = await api(w.token, 'GET', `/api/memory?projectId=${w.projectId}`);
    expect((list.body.items as Body[]).map((r) => r.source)).not.toContain('issue');
    const all = await entries();
    expect((all.body.items as Body[]).map((r) => r.source)).not.toContain('issue');
    expect(all.body.counts).toMatchObject({ live: (all.body.items as Body[]).length });
    expect((await entries('&sources=issue')).status).toBe(400);
  });

  it('is never recalled: a filter naming it is refused, pointing at the find door', async () => {
    const recall = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'store theme',
    });
    expect((recall.body.hits as Body[]).map((h) => h.source)).not.toContain('issue');
    // memory search is the find door's memory filter (ISS-1256); issues are its issue filter
    const byName = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'store theme',
      sourceFilter: ['issue'],
    });
    expect(byName.status).toBe(400);
    expect(JSON.stringify(byName.body)).toMatch(/memory filter[\s\S]*find with type/);
  });

  it('deletes a memory for good on request, keeping only the reason as history', async () => {
    const made = await write({
      source: 'note',
      sourceRef: 'gotcha/junk',
      textContent: 'junk words here',
      ...CURATED,
    });
    const id = made.body.id as string;
    const res = await api(w.token, 'POST', `/api/memory/${id}/retire?projectId=${w.projectId}`, {
      reason: 'junk from the audit',
      delete: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(await db.execute(sql`SELECT 1 FROM memories WHERE id = ${id}`)).toHaveLength(0);
    const kept = await db.execute<{ kind: string; text_content: string }>(sql`
      SELECT kind, text_content FROM memory_upkeep_records WHERE ref = ${`deleted:${id}`}`);
    expect(kept[0]).toMatchObject({ kind: 'deletion' });
    expect(kept[0]?.text_content).toContain('junk from the audit');
  });
});

describe('BC-5: a change meeting what an entry names flags it', () => {
  let issueId = '';
  let noteId = '';
  let quietId = '';

  beforeAll(async () => {
    noteId = (
      await write({
        source: 'note',
        sourceRef: 'gotcha/indexer-skip',
        textContent: 'The indexer skips the embed call when the text did not change',
        ...CURATED,
      })
    ).body.id as string;
    quietId = (
      await write({
        source: 'note',
        sourceRef: 'gotcha/unrelated',
        textContent: 'The web build runs vite with the base path set',
        ...CURATED,
        recheckWhen: 'packages/web-v2/vite.config.ts changes',
      })
    ).body.id as string;
    await putKnowledge('indexer-guide', {
      kind: 'guide',
      title: 'How the indexer embeds',
      body: 'The indexer embeds a memory once per distinct text',
      type: 'fact',
      source: 'packages/core/src/memory/indexer.ts:indexMemory',
      scope: 'memory writes',
      recheckWhen: 'the indexer changes',
    });
    await putKnowledge('indexer-rule', {
      kind: 'rule',
      title: 'Indexer rule',
      body: 'Never embed a memory twice for one text',
      injection: 'always',
      type: 'convention',
      source: 'owner',
      scope: 'memory writes',
      recheckWhen: 'packages/core/src/memory/indexer.ts changes',
    });
    await api(w.token, 'PUT', `/api/orgs/${w.orgId}/knowledge/indexer-ruling`, {
      title: 'Indexer ruling',
      body: 'Vectors are kept for unchanged text',
      injection: 'on_demand',
      source: 'owner',
      scope: 'every project',
      recheckWhen: 'packages/core/src/memory/indexer.ts changes',
    });
    issueId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_paths)
      VALUES (${issueId}, ${w.projectId}, 41, 'indexer rework', 'awaiting_release', ${w.userId}, now(),
              'abc1234def5678abc1234def5678abc1234def56',
              ${JSON.stringify({ commit: 'abc1234def5678abc1234def5678abc1234def56', changes: [{ path: 'packages/core/src/memory/indexer.ts', change: 'modified' }] })}::jsonb)`);
  });

  it('flags the memory, the project entry and the org ruling naming a path the landing touched, and nothing else', async () => {
    const flagged = await recheckForLanding(w.projectId, issueId);
    expect(flagged).toMatchObject({ memories: expect.any(Number), knowledge: 3 });
    const rows = (await entries('&limit=200')).body.items as Body[];
    const note = rows.find((r) => r.id === noteId);
    expect(note?.flagged).toMatchObject({ by: 'ISS-41' });
    expect(String((note?.flagged as Body | undefined)?.reason)).toContain(
      'packages/core/src/memory/indexer.ts',
    );
    expect(rows.find((r) => r.id === quietId)?.flagged).toBeNull();
    expect((await getKnowledge('indexer-guide')).body.recheckDue).toMatchObject({ by: 'ISS-41' });
    expect((await getKnowledge('indexer-ruling')).body.recheckDue).toMatchObject({ by: 'ISS-41' });
  });

  it('weighs a landing once: its close does not flag again what was confirmed since', async () => {
    expect(await recheckForLanding(w.projectId, issueId)).toBeNull();
  });

  it('flags what names a rule when the rule is rewritten, and a rewrite of the entry clears it', async () => {
    const named = await write({
      source: 'note',
      sourceRef: 'gotcha/pace-reader',
      textContent: 'Masters keep one builder unless the work is urgent',
      ...CURATED,
      recheckWhen: 'the rule `pace-rule` changes',
    });
    await putKnowledge('pace-rule', {
      kind: 'rule',
      title: 'Pace',
      body: 'Two builders when a person is blocked',
      type: 'convention',
      source: 'owner',
      scope: 'every master',
      recheckWhen: 'the owner rules on pace',
    });
    let row = ((await entries('&limit=200')).body.items as Body[]).find(
      (r) => r.id === named.body.id,
    );
    expect(row?.flagged).toMatchObject({ by: 'rule pace-rule' });
    await write({
      source: 'note',
      sourceRef: 'gotcha/pace-reader',
      textContent: 'Masters keep one builder, two when a person is blocked',
      ...CURATED,
      recheckWhen: 'the rule `pace-rule` changes',
    });
    row = ((await entries('&limit=200')).body.items as Body[]).find((r) => r.id === named.body.id);
    expect(row?.flagged).toBeNull();
  });

  it('serves no agent learned text a change took out of service, keeps serving a decision in force, and serves the text again once rewritten', async () => {
    const memoryRecall = () =>
      api(w.token, 'POST', '/api/memory/search', {
        projectId: w.projectId,
        query: 'indexer skips the embed call when the text did not change',
        topK: 5,
      });
    const knowledgeRecall = async () => {
      const res = await api(w.token, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
        query:
          'how the indexer embeds a memory once per distinct text, vectors kept for unchanged text',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.knowledge as Body[]).map((h) => h.slug);
    };
    const withheld = await memoryRecall();
    expect(withheld.status, JSON.stringify(withheld.body)).toBe(200);
    expect((withheld.body.hits as Body[]).map((h) => h.id)).not.toContain(noteId);
    expect(withheld.body.withheldForRecheck).toBeGreaterThanOrEqual(1);
    const outOfService = await knowledgeRecall();
    expect(outOfService).not.toContain('indexer-guide');
    // a decision in force is not learned text: flagged, it stays served, since only a person retires it
    expect(outOfService).toContain('indexer-ruling');
    expect((await getKnowledge('indexer-rule')).body.recheckDue).toMatchObject({ by: 'ISS-41' });
    const prompt = await selectAlwaysInjectFromKnowledge(w.projectId);
    expect(prompt.map((f) => f.key)).toContain('indexer-rule');
    // where the next agent finds it to confirm or rewrite: the list, with the re-check owed on it
    const listed = await api(w.token, 'GET', `/api/projects/${w.projectId}/knowledge`);
    const guideRow = (listed.body.rows as Body[]).find((e) => e.slug === 'indexer-guide');
    expect(guideRow?.recheckDue).toMatchObject({ by: 'ISS-41' });

    await write({
      source: 'note',
      sourceRef: 'gotcha/indexer-skip',
      textContent: 'The indexer skips the embed call when the text did not change, as after ISS-41',
      ...CURATED,
    });
    await putKnowledge('indexer-guide', {
      kind: 'guide',
      title: 'How the indexer embeds',
      body: 'The indexer embeds a memory once per distinct text',
      type: 'fact',
      source: 'packages/core/src/memory/indexer.ts:indexMemory',
      scope: 'memory writes',
      recheckWhen: 'the indexer changes',
    });
    const served = await memoryRecall();
    expect((served.body.hits as Body[]).map((h) => h.id)).toContain(noteId);
    expect(await knowledgeRecall()).toContain('indexer-guide');
  });
});
