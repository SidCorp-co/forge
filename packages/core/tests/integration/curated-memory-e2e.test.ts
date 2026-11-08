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
 *    names the rule; a rewrite clears the flag. A temporary entry whose `endsWhen` the landing or the
 *    rewrite meets is retired (ISS-1156); one naming an ending core cannot see is warned, and flagged
 *    once its note window passes unchecked.
 *
 * The embedder is a stand-in for the model: each distinct word is one dimension, so two texts are as
 * close as the words they share. Same text, same vector: what the near-duplicate rule weighs.
 *
 * @direct-test-of packages/core/src/memory/write-service.ts
 * @direct-test-of packages/core/src/memory/curation.ts
 * @direct-test-of packages/core/src/memory/recheck.ts
 * @direct-test-of packages/core/src/memory/endings.ts
 * @direct-test-of packages/core/src/memory/one-per-subject.ts
 * @direct-test-of packages/core/src/memory/search-service.ts
 * @direct-test-of packages/core/src/memory/note-lifetime.ts
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
import { retireLapsedNotes } from '../../src/memory/note-lifetime.js';
import { recheckForLanding } from '../../src/memory/recheck.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';
import { wordVector } from '../helpers/word-vector.js';

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async (_s: unknown, text: string) => wordVector(text),
  embedQuery: async (_s: unknown, text: string) => wordVector(text),
  embedBatch: async (_s: unknown, texts: string[]) => texts.map(wordVector),
}));

const w = { projectId: '', orgId: '', token: '', userId: '' };

beforeAll(async () => {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  w.projectId = project.id;
  w.orgId = project.orgId;
  w.userId = user.id;
  w.token = await userToken(user.id);
});

const write = (body: Body) =>
  api(w.token, 'POST', '/api/memory', { projectId: w.projectId, ...body });
const entries = async (query = '') => {
  const res = await api(w.token, 'GET', `/api/memory/entries?projectId=${w.projectId}${query}`);
  return res;
};
const putKnowledge = (slug: string, body: Body) =>
  api(w.token, 'PUT', `/api/projects/${w.projectId}/knowledge/${slug}`, body);
const getKnowledge = (slug: string) =>
  api(w.token, 'GET', `/api/projects/${w.projectId}/knowledge/${slug}`);

const CURATED = {
  value: 'the next run touching the indexer knows why a vector is reused',
  type: 'fact',
  scope: 'every memory write of this project',
  recheckWhen: 'packages/core/src/memory/indexer.ts changes, or POST /api/memory',
};

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

  it('is not recalled unless the filter names it', async () => {
    const recall = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'store theme',
      strategy: 'keyword',
    });
    expect((recall.body.hits as Body[]).map((h) => h.source)).not.toContain('issue');
    const byName = await api(w.token, 'POST', '/api/memory/search', {
      projectId: w.projectId,
      query: 'store theme',
      strategy: 'keyword',
      sourceFilter: ['issue'],
    });
    expect((byName.body.hits as Body[]).map((h) => h.source)).toEqual(['issue']);
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
    expect(flagged).toMatchObject({ memories: expect.any(Number), knowledge: 2 });
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
});

describe('BC-5: a temporary entry is retired when what ends it happens', () => {
  const archived = async (id: string) => {
    const [row] = (await db.execute(sql`
      SELECT archived_at IS NOT NULL AS archived, metadata->>'archivedBy' AS "archivedBy",
             metadata->>'staleReason' AS "staleReason"
        FROM memories WHERE id = ${id}`)) as unknown as {
      archived: boolean;
      archivedBy: string | null;
      staleReason: string | null;
    }[];
    return row;
  };

  it('retires an entry ending on a path when a landing touches it, and leaves one ending elsewhere', async () => {
    const ends = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-on-schema',
      textContent: 'The decay sweep reads the schema file twice until it is split',
      ...CURATED,
      recheckWhen: 'the decay sweep changes',
      endsWhen: 'packages/core/src/db/schema-memory.ts is split',
    });
    const stays = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-elsewhere',
      textContent: 'The board widens the dock until the size control is pressed',
      ...CURATED,
      recheckWhen: 'the dock changes',
      endsWhen: 'packages/web-v2/src/features/chat-dock/dock.tsx changes',
    });
    const issueId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, merged_at, merged_commit_sha, merged_paths)
      VALUES (${issueId}, ${w.projectId}, 42, 'split the memory schema', 'awaiting_release', ${w.userId}, now(),
              'bcd1234def5678abc1234def5678abc1234def56',
              ${JSON.stringify({ commit: 'bcd1234def5678abc1234def5678abc1234def56', changes: [{ path: 'packages/core/src/db/schema-memory.ts', change: 'modified' }] })}::jsonb)`);
    await recheckForLanding(w.projectId, issueId);
    expect(await archived(ends.body.id as string)).toMatchObject({
      archived: true,
      archivedBy: expect.stringContaining('ISS-42'),
    });
    expect(await archived(stays.body.id as string)).toMatchObject({ archived: false });
  });

  it('retires an entry ending on a rule when the rule is rewritten', async () => {
    const ends = await write({
      source: 'note',
      sourceRef: 'gotcha/ends-on-rule',
      textContent: 'Masters hold one builder while the pace rule says so',
      ...CURATED,
      recheckWhen: 'the masters change',
      endsWhen: 'the rule `builder-cap` is rewritten',
    });
    await putKnowledge('builder-cap', {
      kind: 'rule',
      title: 'Builder cap',
      body: 'Three builders for forge',
      type: 'convention',
      source: 'owner',
      scope: 'every master',
      recheckWhen: 'the owner rules on the cap',
    });
    expect(await archived(ends.body.id as string)).toMatchObject({
      archived: true,
      archivedBy: expect.stringContaining('rule builder-cap'),
    });
  });

  it('warns an ending core cannot see, and flags the entry once its window passes unchecked', async () => {
    const unseen = await write({
      source: 'knowledge',
      sourceRef: 'gotcha/ends-on-plugin',
      textContent: 'The drive skill names the old phase endpoint until the plugin ships its fix',
      ...CURATED,
      recheckWhen: 'the drive skill changes',
      endsWhen: 'forge-plugin 0.9.3 ships',
    });
    expect(unseen.body.warnings).toEqual([
      expect.objectContaining({ code: 'ENDING_UNOBSERVED', path: '/endsWhen' }),
    ]);
    const seen = await write({
      source: 'knowledge',
      sourceRef: 'gotcha/ends-on-key',
      textContent: 'Notes past the window retire unless the window key is raised',
      ...CURATED,
      recheckWhen: 'the window changes',
      endsWhen: 'the policy key `memory.noteWindowDays` changes',
    });
    expect(seen.body.warnings).toBeUndefined();
    await db.execute(sql`
      UPDATE memories SET updated_at = now() - interval '40 days', created_at = now() - interval '40 days'
       WHERE id IN (${unseen.body.id as string}::uuid, ${seen.body.id as string}::uuid)`);
    await retireLapsedNotes();
    expect(await archived(unseen.body.id as string)).toMatchObject({
      archived: false,
      staleReason: expect.stringContaining('core cannot observe'),
    });
    expect(await archived(seen.body.id as string)).toMatchObject({
      archived: false,
      staleReason: null,
    });
  });
});
