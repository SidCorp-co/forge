import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';

// REQ-33 BC-4, ISS-434 criterion 3: a person corrects a memory from the item page with a reason, and
// the item's own read (the Memory tab) still holds the old text as an earlier revision, still names
// the agent that wrote it as its writer, and names the person who corrected it, with why. Every
// source a person may correct there keeps its revision, a decision as much as a note.
//
// @direct-test-of packages/core/src/memory/write-service.ts
// @direct-test-of packages/core/src/memory/revisions-service.ts
// @direct-test-of packages/core/src/memory/tool.ts

type Entry = Record<string, unknown> & { id: string; sourceRef: string };

async function onItem(w: World, ref: string): Promise<Entry[]> {
  const res = await api(
    w.token,
    'GET',
    `/api/memory/entries?projectId=${w.projectId}&cites=${encodeURIComponent(ref)}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as Entry[];
}

const correct = (w: World, id: string, body: unknown) =>
  api(w.token, 'POST', `/api/memory/${id}/correct?projectId=${w.projectId}`, body);

describe('a memory corrected from the item it names', () => {
  let w: World;
  let agentId: string;
  let agentToken: string;

  async function agentWrites(source: string, sourceRef: string, textContent: string) {
    const res = await api(agentToken, 'POST', '/api/memory', {
      projectId: w.projectId,
      source,
      sourceRef,
      textContent,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  beforeAll(async () => {
    w = await world();
    const agent = await createTestUser({ kind: 'agent', verified: true });
    agentId = agent.id;
    await addProjectMember(w.projectId, agent.id, 'member');
    agentToken = await userToken(agent.id);
    await issue(w, { status: 'open', createdAt: ago(2) }); // ISS-1
    await agentWrites(
      'note',
      'gotcha/rebase',
      'After a rebase, test:changed shows 24 failed files (ISS-1).',
    );
    await agentWrites(
      'decision',
      'decision/board',
      'The board stays flat (ISS-1), owner 2026-10-04.',
    );
  });

  it('keeps the old text as an earlier revision on the item, the agent as its writer, and the person as its corrector', async () => {
    const before = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'gotcha/rebase') as Entry;
    expect(before.writtenBy).toMatchObject({ id: agentId, agent: true });
    expect(before.revisions).toEqual([]);

    const res = await correct(w, before.id, {
      text: 'After a rebase, test:changed shows 24 failed files and 0 failed tests (ISS-1).',
      reason: 'Read the run again: no test failed',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'gotcha/rebase') as Entry;
    expect(after.text).toBe(
      'After a rebase, test:changed shows 24 failed files and 0 failed tests (ISS-1).',
    );
    expect(after.writtenBy).toMatchObject({ id: agentId, agent: true });
    expect(after.corrections).toEqual([
      expect.objectContaining({
        reason: 'Read the run again: no test failed',
        by: expect.objectContaining({ id: w.userId, agent: false }),
      }),
    ]);
    expect(after.revisions).toEqual([
      {
        text: 'After a rebase, test:changed shows 24 failed files (ISS-1).',
        writtenBy: expect.objectContaining({ id: agentId, agent: true }),
        replacedAt: expect.any(String),
      },
    ]);
    expect(after.revisionCount).toBe(1);
  });

  it('a second correction keeps both earlier texts, newest first', async () => {
    const row = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'gotcha/rebase') as Entry;
    const res = await correct(w, row.id, {
      text: 'After a rebase, test:changed lists 24 files; none failed (ISS-1).',
      reason: 'Shorter, same fact',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'gotcha/rebase') as Entry;
    expect((after.revisions as Body[]).map((r) => r.text)).toEqual([
      'After a rebase, test:changed shows 24 failed files and 0 failed tests (ISS-1).',
      'After a rebase, test:changed shows 24 failed files (ISS-1).',
    ]);
    expect(after.writtenBy).toMatchObject({ id: agentId });
    expect((after.corrections as Body[]).map((c) => c.reason)).toEqual([
      'Read the run again: no test failed',
      'Shorter, same fact',
    ]);
  });

  it('a decision corrected from the item keeps its old text too', async () => {
    const row = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'decision/board') as Entry;
    const res = await correct(w, row.id, {
      text: 'The board stays flat with hairline dividers (ISS-1), owner 2026-10-04.',
      reason: 'The owner added the dividers',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'decision/board') as Entry;
    expect((after.revisions as Body[]).map((r) => r.text)).toEqual([
      'The board stays flat (ISS-1), owner 2026-10-04.',
    ]);
    expect(after.writtenBy).toMatchObject({ id: agentId });
  });

  it('a correction refused leaves no revision behind', async () => {
    const row = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'decision/board') as Entry;
    const same = await correct(w, row.id, { text: row.text, reason: 'no change' });
    expect(same.body.code).toBe('MEMORY_UNCHANGED');
    const noReason = await correct(w, row.id, { text: 'Something else (ISS-1).', reason: 'x' });
    expect(noReason.status).toBe(400);
    const after = (await onItem(w, 'ISS-1')).find((r) => r.sourceRef === 'decision/board') as Entry;
    expect(after.revisions).toHaveLength(1);
  });
});

// ISS-789: a write under a ref that already holds an entry says it replaced one, names the
// revision that kept the old text, and the entry reads back by its id.
describe('a memory write over an existing ref says it replaced an entry', () => {
  let w: World;
  const write = (sourceRef: string, textContent: string, source = 'decision') =>
    api(w.token, 'POST', '/api/memory', { projectId: w.projectId, source, sourceRef, textContent });
  const read = (id: string, projectId?: string) =>
    api(w.token, 'GET', `/api/memory/${id}?projectId=${projectId ?? w.projectId}`);

  beforeAll(async () => {
    w = await world();
  });

  it('a fresh write carries no replaced field', async () => {
    const res = await write('REQ-13', 'Flat board.');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).not.toHaveProperty('replaced');
  });

  it('a replace answers the same id, names the revision holding the earlier text', async () => {
    const first = await write('REQ-14', 'First decision.');
    const second = await write('REQ-14', 'Second decision.');
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const replaced = second.body.replaced as { revisionId: string };
    expect(replaced.revisionId).toEqual(expect.any(String));

    const revs = await api(
      w.token,
      'GET',
      `/api/memory/revisions?projectId=${w.projectId}&memoryId=${second.body.id}`,
    );
    const kept = (revs.body.items as Body[]).find((r) => r.id === replaced.revisionId);
    expect(kept?.textContent).toBe('First decision.');

    const third = await write('REQ-14', 'Third decision.');
    const next = third.body.replaced as { revisionId: string };
    expect(next.revisionId).not.toBe(replaced.revisionId);
  });

  it('a rewrite with the same text says it replaced, and names no revision', async () => {
    await write('REQ-15', 'Same text.');
    const again = await write('REQ-15', 'Same text.');
    expect(again.body.replaced).toEqual({ revisionId: null });
  });

  it('reads one entry by its id, and refuses an unknown id or another project by name', async () => {
    const put = await write('REQ-16', 'Readable by id.');
    const got = await read(put.body.id as string);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({
      id: put.body.id,
      sourceRef: 'REQ-16',
      source: 'decision',
      textContent: 'Readable by id.',
      archivedAt: null,
    });

    const unknown = await read('00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('MEMORY_NOT_FOUND');

    const other = await world();
    const foreign = await read(put.body.id as string, other.projectId);
    expect(foreign.status).toBe(403);

    const bad = await read('not-a-uuid');
    expect(bad.status).toBe(400);
  });
});
