import { MEMORY_CHECK_AFTER_DAYS } from '@forge/contracts/memory';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';

// A person's "still true": the Memory page's needs-a-check count could only fall by rewriting the
// text (HOP walk 2026-10-08: 91 of 94 never verified). Saying a memory still holds stamps it
// checked, by whom, keeps a history entry and clears the reasons it needed a check; a cited record
// that changes afterwards brings the reason back. Whoever may write the project's memory may say it.

type Entry = Record<string, unknown> & {
  id: string;
  sourceRef: string;
  needsCheck: string[];
  verifiedAt: string | null;
  verifiedBy: { id: string; name: string; agent: boolean } | null;
};

const DAY_H = 24;
const due = MEMORY_CHECK_AFTER_DAYS * DAY_H;

describe('a person says a memory is still true', () => {
  let w: World;
  let movingId: string;

  const entries = async (state = 'live') => {
    const res = await api(
      w.token,
      'GET',
      `/api/memory/entries?projectId=${w.projectId}&state=${state}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items as Entry[];
  };
  const byRef = async (ref: string, state = 'live') =>
    (await entries(state)).find((e) => e.sourceRef === ref) as Entry;
  const verify = (ids: string[], token = w.token) =>
    api(token, 'POST', `/api/memory/verify?projectId=${w.projectId}`, { ids });

  async function seed(ref: string, text: string, metadata: object = {}, written = ago(due + 1)) {
    await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, metadata, created_at, updated_at)
      VALUES (${w.projectId}, 'note', ${ref}, ${text}, ${JSON.stringify(metadata)}::jsonb,
              ${written.toISOString()}, ${written.toISOString()})
    `);
  }

  beforeAll(async () => {
    w = await world();
    const moving = await issue(w, { status: 'open', createdAt: ago(10 * DAY_H) }); // ISS-1
    movingId = moving.id;
    await db.execute(
      sql`UPDATE issues SET updated_at = ${ago(1).toISOString()} WHERE id = ${moving.id}`,
    );
    await seed('old', 'The board is flat.');
    await seed('flagged', 'The board shows ten columns.', {
      staleSince: ago(1).toISOString(),
      supersededBy: 'ISS-9',
      staleReason: 'ten became eight',
    });
    await seed('bulk-a', 'Cards keep their order.');
    await seed('bulk-b', 'Owners read the board first.');
    await seed('bulk-c', 'Columns are named by status.');
    await seed('cites', 'ISS-1 keeps the board flat.', {}, ago(2));
  }, 120_000);

  it('stamps who checked it and when, clears the reason, and keeps a history entry', async () => {
    const before = await byRef('old', 'stale');
    expect(before.needsCheck).toEqual(['unchecked']);
    expect(before.verifiedAt).toBeNull();

    const res = await verify([before.id]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await byRef('old');
    expect(after.needsCheck).toEqual([]);
    expect(after.verifiedBy).toMatchObject({ id: w.userId, agent: false });
    expect(Date.now() - Date.parse(after.verifiedAt as string)).toBeLessThan(60_000);
    expect((await entries('stale')).map((e) => e.sourceRef)).not.toContain('old');
    const [kept] = (await db.execute(
      sql`SELECT metadata->'checks' AS checks FROM memories WHERE id = ${before.id}`,
    )) as unknown as { checks: { by: string; at: string }[] }[];
    expect(kept?.checks).toHaveLength(1);
    expect(kept?.checks[0]?.by).toBe(w.userId);
  });

  it('clears a release flag along with it', async () => {
    const flagged = await byRef('flagged', 'stale');
    expect(flagged.needsCheck).toContain('flagged');
    await verify([flagged.id]);
    const after = await byRef('flagged');
    expect(after.needsCheck).toEqual([]);
    expect(after.flagged).toBeNull();
  });

  it('brings the reason back when a cited record changes again', async () => {
    const row = await byRef('cites', 'stale');
    expect(row.needsCheck).toEqual(['changed']);
    await verify([row.id]);
    expect((await byRef('cites')).needsCheck).toEqual([]);

    await db.execute(
      sql`UPDATE issues SET updated_at = now() + interval '1 minute' WHERE id = ${movingId}`,
    );
    expect((await byRef('cites')).needsCheck).toEqual(['changed']);
  });

  it('stamps each row of a bulk with its own check and history entry', async () => {
    const ids = await Promise.all(
      ['bulk-a', 'bulk-b', 'bulk-c'].map(async (r) => (await byRef(r, 'stale')).id),
    );
    const res = await verify(ids);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.verified as { id: string }[]).map((v) => v.id)).toEqual(ids);
    for (const r of ['bulk-a', 'bulk-b', 'bulk-c']) {
      const e = await byRef(r);
      expect(e.needsCheck, r).toEqual([]);
      expect(e.verifiedBy, r).toMatchObject({ id: w.userId });
    }
    const rows = (await db.execute(
      sql`SELECT jsonb_array_length(metadata->'checks') AS n FROM memories WHERE source_ref LIKE 'bulk-%' AND project_id = ${w.projectId}`,
    )) as unknown as { n: number }[];
    expect(rows.map((r) => Number(r.n))).toEqual([1, 1, 1]);
  });

  it('refuses a bulk naming a row it cannot check, by name, and checks none of them', async () => {
    await seed('late-a', 'Late one.');
    const a = (await byRef('late-a', 'stale')).id;
    const res = await verify([a, '00000000-0000-4000-8000-000000000000']);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MEMORY_NOT_FOUND');
    expect((await byRef('late-a', 'stale')).needsCheck).toEqual(['unchecked']);
  });

  it('refuses a person without write access, by name', async () => {
    const reader = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, reader.id, 'viewer');
    const id = (await byRef('late-a', 'stale')).id;
    const res = await verify([id], await userToken(reader.id));
    expect(res.status).toBe(403);
    expect(typeof res.body.code).toBe('string');
    expect((await byRef('late-a', 'stale')).needsCheck).toEqual(['unchecked']);
  });
});
