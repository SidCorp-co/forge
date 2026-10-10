import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { ago, issue, requirement, type World, world } from '../helpers/forecast-world.js';

// REQ-29 BC-5's AGE, read through the list route the Requirements page reads: the time a requirement
// has stood in its state, from its kernel transitions. Live dev.227 read every row "1m" after area and
// short name were set on all 45, because AGE read the last edit.

const moved = (entity: 'requirement' | 'issue', id: string, from: string, to: string, at: Date) =>
  db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type, actor_agency, source, created_at)
    VALUES (${randomUUID()}, ${entity}, ${id}, ${from}, ${to}, 'system', 'agent', 'fixture', ${at.toISOString()})`);

/** Agreed at r1, moved inside the kernel's own transaction, its move recorded at `at`. */
async function agreedAt(w: World, title: string, at: Date): Promise<{ id: string; key: string }> {
  const r = await requirement(w, title);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${r.id}, 1, 'current', ${JSON.stringify({ goal: title })}::jsonb, 'seed', ${w.userId}, 'human', ${w.userId}, now())`);
    await tx.execute(sql`
      UPDATE requirements SET status = 'agreed', current_revision = 1, owner_id = ${w.userId} WHERE id = ${r.id}`);
  });
  await moved('requirement', r.id, 'draft', 'agreed', at);
  return r;
}

async function standingOf(w: World, key: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/requirements`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.requirements as Body[]).find((r) => r.key === key);
  expect(row, `${key} is listed`).toBeDefined();
  return row?.standing as Body;
}

describe('how long a requirement has stood in its state, on the list', () => {
  let w: World;
  const agreedThen = ago(72);

  beforeAll(async () => {
    w = await world();
  });

  it('a short-name write moves its touched time and leaves its age', async () => {
    const r = await agreedAt(w, 'The board loads fast', agreedThen);
    const before = await standingOf(w, r.key);
    expect(before.stateSince).toBe(agreedThen.toISOString());

    const put = await api(
      w.token,
      'PUT',
      `/api/projects/${w.projectId}/requirements/${r.key}/placement`,
      {
        shortName: 'Board speed',
      },
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const after = await standingOf(w, r.key);
    expect(after.stateSince).toBe(agreedThen.toISOString());
    expect(Date.parse(after.touchedAt as string)).toBeGreaterThan(agreedThen.getTime() + 3_600_000);
  });

  it('in delivery, it counts from when its first issue started', async () => {
    const r = await agreedAt(w, 'The board exports its cards', agreedThen);
    const started = ago(24);
    const worked = await issue(w, {
      status: 'in_progress',
      createdAt: ago(48),
      requirementId: r.id,
    });
    await moved('issue', worked.id, 'open', 'in_progress', started);
    const s = await standingOf(w, r.key);
    expect(s.state).toBe('in_delivery');
    expect(s.stateSince).toBe(started.toISOString());
  });

  it('a requirement no status move has touched counts from when it was filed', async () => {
    const r = await requirement(w, 'The board prints');
    const [row] = (await db.execute(
      sql`SELECT created_at FROM requirements WHERE id = ${r.id}`,
    )) as unknown as Array<{
      created_at: Date | string;
    }>;
    const s = await standingOf(w, r.key);
    expect(s.stateSince).toBe(new Date(row?.created_at as string).toISOString());
  });
});
