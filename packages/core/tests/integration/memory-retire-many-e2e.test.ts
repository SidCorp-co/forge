// ISS-1104 (FB-553): retiring memories took one id per call, and an agent sweeping 55 stale notes
// was refused 429 partway, since each call spent a memory write. One call now retires up to a
// hundred under one reason and one write, answering each id retired or refused by name; a row it
// cannot retire never stops the others. One id per call still works.
// @direct-test-of packages/core/src/memory/person-acts.ts
// @direct-test-of packages/core/src/memory/write-routes.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { RULES } from '../../src/lib/rate-limits.js';
import { MEMORY_RETIRE_MANY_MAX } from '../../src/memory/person-acts.js';
import { api, patToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let projectId = '';
let agentId = '';

async function seed(ref: string, source = 'note'): Promise<string> {
  const [row] = (await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata)
    VALUES (${projectId}, ${source}, ${ref}, ${`Note ${ref}.`}, '{}'::jsonb)
    RETURNING id`)) as unknown as { id: string }[];
  return (row as { id: string }).id;
}

const archived = async (id: string) =>
  (
    (await db.execute(
      sql`SELECT archived_at, metadata->'retired'->>'reason' AS reason FROM memories WHERE id = ${id}`,
    )) as unknown as { archived_at: Date | null; reason: string | null }[]
  )[0];

beforeAll(async () => {
  agentId = (await createTestUser({ kind: 'agent' })).id;
  projectId = (await createTestProject(agentId)).id;
  await addProjectMember(projectId, agentId, 'owner');
});

describe('retiring many memories in one call', () => {
  it('retires more rows than a minute of writes allows, spending one write', async () => {
    const token = await patToken(agentId, [projectId], 'sweep');
    const count = RULES.memoryWrite.max + 25;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await seed(`sweep-${i}`));

    const res = await api(token, 'POST', `/api/memory/retire?projectId=${projectId}`, {
      ids,
      reason: 'superseded by the release notes',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe(String(RULES.memoryWrite.max - 1));
    expect((res.body.retired as { id: string }[]).map((r) => r.id)).toEqual(ids);
    expect(res.body.refused).toEqual([]);
    for (const id of ids) {
      const row = await archived(id);
      expect(row?.archived_at, id).not.toBeNull();
      expect(row?.reason).toBe('superseded by the release notes');
    }
  });

  it('answers each row it cannot retire by name and retires the rest', async () => {
    const token = await patToken(agentId, [projectId], 'mixed');
    const live = await seed('mixed-live');
    const gone = await seed('mixed-gone');
    const mirror = await seed('ISS-7', 'issue');
    const stranger = randomUUID();
    await api(token, 'POST', `/api/memory/${gone}/retire?projectId=${projectId}`, {
      reason: 'already wrong',
    });

    const res = await api(token, 'POST', `/api/memory/retire?projectId=${projectId}`, {
      ids: [live, gone, mirror, stranger],
      reason: 'cleaning the board',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.retired as { id: string }[]).map((r) => r.id)).toEqual([live]);
    expect(
      (res.body.refused as { id: string; code: string }[]).map(({ id, code }) => [id, code]),
    ).toEqual([
      [gone, 'MEMORY_ALREADY_RETIRED'],
      [mirror, 'MEMORY_MIRROR_READ_ONLY'],
      [stranger, 'MEMORY_NOT_FOUND'],
    ]);
    expect((await archived(mirror))?.archived_at).toBeNull();
  });

  it(`refuses a list over ${MEMORY_RETIRE_MANY_MAX} by name and retires none of it`, async () => {
    const token = await patToken(agentId, [projectId], 'too many');
    const first = await seed('over-cap');
    const ids = [first, ...Array.from({ length: MEMORY_RETIRE_MANY_MAX }, () => randomUUID())];
    const res = await api(token, 'POST', `/api/memory/retire?projectId=${projectId}`, {
      ids,
      reason: 'too many at once',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ids');
    expect((await archived(first))?.archived_at).toBeNull();
  });

  it('still retires one row by its own id', async () => {
    const token = await patToken(agentId, [projectId], 'one');
    const one = await seed('one-by-id');
    const res = await api(token, 'POST', `/api/memory/${one}/retire?projectId=${projectId}`, {
      reason: 'wrong about the board',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(one);
    expect((await archived(one))?.archived_at).not.toBeNull();
  });
});
