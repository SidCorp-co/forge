import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { runMemoryDecay } from '../../src/memory/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { ago, issue, requirement, type World, world } from '../helpers/forecast-world.js';

// MJ-1, MJ-2, MJ-3: a person reads the project's memory — who wrote each row, when, what it cites
// and which of those no longer resolve — and corrects or retires one with a reason. Nothing a
// person did, and nothing decay did, leaves a row without saying so.

type Entry = Record<string, unknown> & { id: string; sourceRef: string };

async function entries(w: World, query = ''): Promise<Entry[]> {
  const res = await api(w.token, 'GET', `/api/memory/entries?projectId=${w.projectId}${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Entry[];
}

const byRef = (rows: Entry[], ref: string) => rows.find((r) => r.sourceRef === ref);

async function write(w: World, token: string, sourceRef: string, textContent: string) {
  return api(token, 'POST', '/api/memory', {
    projectId: w.projectId,
    source: 'note',
    sourceRef,
    textContent,
  });
}

const act = (w: World, id: string, verb: 'correct' | 'retire', body: unknown, token = w.token) =>
  api(token, 'POST', `/api/memory/${id}/${verb}?projectId=${w.projectId}`, body);

const code = (b: Body) => b.code;

describe('memory as a person reads it, and a person acts on it', () => {
  let w: World;
  let agentToken: string;
  let agentId: string;

  beforeAll(async () => {
    w = await world();
    const agent = await createTestUser({ kind: 'agent' });
    agentId = agent.id;
    await addProjectMember(w.projectId, agent.id, 'member');
    agentToken = await userToken(agent.id);
    await issue(w, { status: 'dropped', createdAt: ago(5) }); // ISS-1
    await issue(w, { status: 'closed', createdAt: ago(4), mergedAt: ago(4) }); // ISS-2
    const archived = await issue(w, { status: 'open', createdAt: ago(3) }); // ISS-3
    await db.execute(sql`UPDATE issues SET archived_at = now() WHERE id = ${archived.id}`);
    await requirement(w, 'The board keeps its cards'); // REQ-1

    const cites = await write(
      w,
      agentToken,
      'gotcha/cites',
      'Owner chose the flat board (ISS-1, ISS-2, ISS-3, ISS-99; REQ-1, REQ-9), 2026-10-04.',
    );
    expect(cites.status, JSON.stringify(cites.body)).toBe(201);
    const clean = await write(w, w.token, 'gotcha/clean', 'The board is flat (ISS-2, REQ-1).');
    expect(clean.status, JSON.stringify(clean.body)).toBe(201);
  });

  it('names who wrote each row, a person or an agent', async () => {
    const rows = await entries(w);
    expect(byRef(rows, 'gotcha/cites')?.writtenBy).toMatchObject({ id: agentId, agent: true });
    expect(byRef(rows, 'gotcha/clean')?.writtenBy).toMatchObject({ id: w.userId, agent: false });
  });

  it('names each cited record that no longer resolves, and none that still does', async () => {
    const row = byRef(await entries(w), 'gotcha/cites');
    expect(((row?.cites ?? []) as { ref: string }[]).map((c) => c.ref)).toEqual([
      'ISS-1',
      'ISS-2',
      'ISS-3',
      'ISS-99',
      'REQ-1',
      'REQ-9',
    ]);
    expect(row?.staleRefs).toEqual([
      { ref: 'ISS-1', kind: 'issue', why: 'dropped' },
      { ref: 'ISS-3', kind: 'issue', why: 'archived' },
      { ref: 'ISS-99', kind: 'issue', why: 'missing' },
      { ref: 'REQ-9', kind: 'requirement', why: 'missing' },
    ]);
    expect(byRef(await entries(w), 'gotcha/clean')?.staleRefs).toEqual([]);
  });

  it('lists under stale only the rows that name a gone record or carry a release flag, of rows written today', async () => {
    const stale = await entries(w, '&state=stale');
    expect(stale.map((r) => r.sourceRef)).toEqual(['gotcha/cites']);
  });

  it('refuses a correction with no reason, of a mirror, unchanged, or of no such row — by name', async () => {
    const row = byRef(await entries(w), 'gotcha/clean') as Entry;
    const noReason = await act(w, row.id, 'correct', { text: 'The board is flat.' });
    expect(noReason.status).toBe(400);

    const mirrorId = randomUUID();
    await db.execute(sql`
      INSERT INTO memories (id, project_id, source, source_ref, text_content)
      VALUES (${mirrorId}, ${w.projectId}, 'issue', ${randomUUID()}, 'issue 2 text')
    `);
    const mirror = await act(w, mirrorId, 'correct', { text: 'x', reason: 'it is wrong' });
    expect(mirror.status).toBe(422);
    expect(code(mirror.body)).toBe('MEMORY_MIRROR_READ_ONLY');

    const same = await act(w, row.id, 'correct', {
      text: 'The board is flat (ISS-2, REQ-1).',
      reason: 'checked',
    });
    expect(code(same.body)).toBe('MEMORY_UNCHANGED');

    const none = await act(w, randomUUID(), 'retire', { reason: 'gone' });
    expect(none.status).toBe(404);
    expect(code(none.body)).toBe('MEMORY_NOT_FOUND');
  });

  it('a correction keeps the old body, names who and why, verifies the row and clears the release flag', async () => {
    await db.execute(sql`
      UPDATE memories SET metadata = metadata || '{"staleSince":"2026-10-01T00:00:00Z","supersededBy":"ISS-2","staleReason":"ISS-2 moved the board to cards"}'::jsonb
      WHERE project_id = ${w.projectId} AND source_ref = 'gotcha/clean'
    `);
    const flagged = byRef(await entries(w), 'gotcha/clean') as Entry;
    expect(flagged.flagged).toEqual({
      since: '2026-10-01T00:00:00Z',
      by: 'ISS-2',
      reason: 'ISS-2 moved the board to cards',
    });
    expect(flagged.verifiedAt).toBeNull();

    const res = await act(w, flagged.id, 'correct', {
      text: 'The board is flat and keeps its cards (REQ-1).',
      reason: 'the owner restated it on 2026-10-08',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = byRef(await entries(w), 'gotcha/clean') as Entry;
    expect(row.text).toBe('The board is flat and keeps its cards (REQ-1).');
    expect(row.flagged).toBeNull();
    expect(row.verifiedAt).not.toBeNull();
    expect(row.corrections).toEqual([
      expect.objectContaining({
        reason: 'the owner restated it on 2026-10-08',
        by: expect.objectContaining({ id: w.userId }),
      }),
    ]);
    const revisions = await api(
      w.token,
      'GET',
      `/api/memory/revisions?projectId=${w.projectId}&memoryId=${row.id}`,
    );
    expect((revisions.body.items as Body[]).map((r) => r.textContent)).toContain(
      'The board is flat (ISS-2, REQ-1).',
    );

    const rewrite = await write(w, agentToken, 'gotcha/clean', 'The board is flat, cards kept.');
    expect(rewrite.status).toBe(201);
    const after = byRef(await entries(w), 'gotcha/clean') as Entry;
    expect(after.corrections).toHaveLength(1);
    expect(after.writtenBy).toMatchObject({ id: agentId });
  });

  it('a retirement hides the row from every live read, keeps who and why, and is never revived by a rewrite', async () => {
    const row = byRef(await entries(w), 'gotcha/cites') as Entry;
    const res = await act(w, row.id, 'retire', {
      reason: 'ISS-1 was dropped; the board is not flat',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(byRef(await entries(w), 'gotcha/cites')).toBeUndefined();
    const get = await api(
      w.token,
      'GET',
      `/api/memory?projectId=${w.projectId}&sourceRef=gotcha/cites`,
    );
    expect(get.body.items).toEqual([]);

    const retired = byRef(await entries(w, '&state=retired'), 'gotcha/cites') as Entry;
    expect(retired.retired).toMatchObject({
      reason: 'ISS-1 was dropped; the board is not flat',
      by: expect.objectContaining({ id: w.userId }),
    });

    const again = await act(w, row.id, 'retire', { reason: 'twice' });
    expect(again.status).toBe(409);
    expect(code(again.body)).toBe('MEMORY_ALREADY_RETIRED');

    const revive = await write(w, agentToken, 'gotcha/cites', 'Owner chose the flat board.');
    expect(revive.status).toBe(409);
    expect(code(revive.body)).toBe('MEMORY_ALREADY_RETIRED');
  });

  it('a row decay archives says which rule archived it', async () => {
    await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, metadata, retrieval_count)
      VALUES (${w.projectId}, 'note', 'gotcha/flagged-long-ago', 'old fact',
              ${JSON.stringify({ staleSince: new Date(Date.now() - 20 * 86_400_000).toISOString(), supersededBy: 'ISS-2', staleReason: 'ISS-2 moved it' })}::jsonb, 5)
    `);
    await runMemoryDecay();
    const row = byRef(await entries(w, '&state=retired'), 'gotcha/flagged-long-ago') as Entry;
    expect(row.archivedBy).toEqual({ rule: 'flagged', by: 'ISS-2' });
    expect(row.retired).toBeNull();
  });

  it('a reader without write access cannot correct or retire', async () => {
    const reader = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, reader.id, 'viewer');
    const row = byRef(await entries(w), 'gotcha/clean') as Entry;
    const res = await act(w, row.id, 'retire', { reason: 'not mine' }, await userToken(reader.id));
    expect(res.status).toBe(403);
  });

  // ISS-457 round 1 and ISS-470 both wrote a run's learning as source issue under the issue's id,
  // and each replaced the issue's own search entry with a 201: the call a run reaches for is planted
  // whole. A learning about an issue is its own row, linked to the issue; the mirror stays core's.
  describe('a learning a run writes about an issue', () => {
    const mirrorOf = async (ref: string) =>
      (
        await db.execute<{ text_content: string }>(sql`
          SELECT text_content FROM memories WHERE project_id = ${w.projectId} AND source = 'issue' AND source_ref = ${ref}
        `)
      ).map((r) => r.text_content);
    const learn = (sourceRef: string, textContent: string, source = 'issue') =>
      api(agentToken, 'POST', '/api/memory', { projectId: w.projectId, source, sourceRef, textContent });

    it('lands as its own note linked to the issue, by its id or its key, and leaves the mirror as core wrote it', async () => {
      const target = await issue(w, { status: 'open', createdAt: ago(1) }); // ISS-4
      await db.execute(sql`
        INSERT INTO memories (project_id, source, source_ref, text_content)
        VALUES (${w.projectId}, 'issue', ${target.id}, 'ISS-4 text as core indexed it')
      `);
      const byId = await learn(target.id, 'A rebase after the merge check is a new check.');
      expect(byId.status, JSON.stringify(byId.body)).toBe(201);
      expect(byId.body.landedAs).toMatchObject({ source: 'note', about: target.key });
      expect(await mirrorOf(target.id)).toEqual(['ISS-4 text as core indexed it']);

      const byKey = await learn(target.key, `${target.key}: the box reaps its own tree after close.`);
      expect(byKey.status, JSON.stringify(byKey.body)).toBe(201);
      expect(byKey.body.landedAs).toMatchObject({ source: 'note', about: target.key });
      expect(byKey.body.id).not.toBe(byId.body.id);
      expect(await mirrorOf(target.key)).toEqual([]);

      const onIssue = (await entries(w, `&cites=${target.key}`)).map((r) => r.text);
      expect(onIssue).toEqual(
        expect.arrayContaining([
          `A rebase after the merge check is a new check. (${target.key})`,
          `${target.key}: the box reaps its own tree after close.`,
        ]),
      );
      const [linked] = await db.execute<{ source: string; issue_id: string | null }>(sql`
        SELECT source, metadata->>'issueId' AS issue_id FROM memories WHERE id = ${byId.body.id as string}
      `);
      expect(linked).toEqual({ source: 'note', issue_id: target.id });

      const again = await learn(target.id, 'A rebase after the merge check is a new check.');
      expect(again.body.id).toBe(byId.body.id);
    });

    it('refuses by name a write that would still replace an indexed row, naming the route that keeps both', async () => {
      for (const [source, ref] of [
        ['comment', randomUUID()],
        ['job', randomUUID()],
        ['issue', randomUUID()],
        ['issue', 'ISS-99'],
      ] as const) {
        const res = await learn(ref, 'A learning the run meant to keep.', source);
        expect(res.status, `${source} ${ref}: ${JSON.stringify(res.body)}`).toBe(422);
        expect(code(res.body)).toBe('MEMORY_MIRROR_READ_ONLY');
        expect(String(res.body.detail)).toContain('source note');
      }
    });
  });
});
