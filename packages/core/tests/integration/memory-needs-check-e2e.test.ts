import { MEMORY_CHECK_AFTER_DAYS } from '@forge/contracts/memory';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { ago, issue, type World, world } from '../helpers/forecast-world.js';

// The HOP journey walk (2026-10-08): the Memory page's "Needs a check" read 0 while 91 of 94
// memories had never been verified. A memory needs a check when nobody has checked it for
// MEMORY_CHECK_AFTER_DAYS days, when a record it cites changed after it was last written or
// checked, when a record it cites no longer resolves, or when a release flagged it. Each row says
// which, and the page reads each list's count from the same rule.

type Entry = Record<string, unknown> & { id: string; sourceRef: string; needsCheck: string[] };

const DAY_H = 24;
const due = MEMORY_CHECK_AFTER_DAYS * DAY_H;

async function read(w: World, state: string) {
  const res = await api(
    w.token,
    'GET',
    `/api/memory/entries?projectId=${w.projectId}&state=${state}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { items: Entry[]; total: number; counts: Record<string, number> };
}

async function seed(
  w: World,
  ref: string,
  text: string,
  at: { written: Date; verified?: Date; metadata?: object; archived?: boolean },
) {
  await db.execute(sql`
    INSERT INTO memories (project_id, source, source_ref, text_content, metadata, created_at, updated_at, last_verified_at, archived_at)
    VALUES (${w.projectId}, 'note', ${ref}, ${text}, ${JSON.stringify(at.metadata ?? {})}::jsonb,
            ${at.written.toISOString()}, ${at.written.toISOString()}, ${at.verified?.toISOString() ?? null},
            ${at.archived ? at.written.toISOString() : null})
  `);
}

describe('which memories need a check', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    const settled = await issue(w, {
      status: 'closed',
      createdAt: ago(10 * DAY_H),
      mergedAt: ago(9 * DAY_H),
    }); // ISS-1
    const moving = await issue(w, { status: 'open', createdAt: ago(10 * DAY_H) }); // ISS-2
    await issue(w, { status: 'dropped', createdAt: ago(10 * DAY_H) }); // ISS-3
    await db.execute(
      sql`UPDATE issues SET updated_at = ${ago(9 * DAY_H).toISOString()} WHERE id = ${settled.id}`,
    );
    await db.execute(
      sql`UPDATE issues SET updated_at = ${ago(1).toISOString()} WHERE id = ${moving.id}`,
    );

    await seed(w, 'never-checked', 'The board is flat.', { written: ago(due + 1) });
    await seed(w, 'checked-lately', 'Cards keep their order.', {
      written: ago(10 * DAY_H),
      verified: ago(due - 2),
    });
    await seed(w, 'fresh', 'Owners read the board first.', { written: ago(1) });
    await seed(w, 'cites-settled', 'ISS-1 made the board flat.', { written: ago(2) });
    await seed(w, 'cites-moving', 'ISS-2 keeps the board flat.', { written: ago(2) });
    await seed(w, 'cites-gone', 'ISS-3 decided the column order.', { written: ago(2) });
    await seed(w, 'flagged', 'The board shows ten columns.', {
      written: ago(2),
      metadata: {
        staleSince: ago(1).toISOString(),
        supersededBy: 'ISS-1',
        staleReason: 'ten became eight',
      },
    });
    await seed(w, 'retired', 'The board was a list.', { written: ago(10 * DAY_H), archived: true });
  }, 120_000);

  it('lists every memory due a check, each with why, and no other', async () => {
    const stale = await read(w, 'stale');
    const why = Object.fromEntries(stale.items.map((e) => [e.sourceRef, e.needsCheck]));
    expect(why).toEqual({
      'never-checked': ['unchecked'],
      'cites-moving': ['changed'],
      'cites-gone': ['gone'],
      flagged: ['flagged'],
    });
    expect(stale.total).toBe(4);
    const moving = stale.items.find((e) => e.sourceRef === 'cites-moving');
    expect(((moving?.changed ?? []) as { ref: string }[]).map((c) => c.ref)).toEqual(['ISS-2']);
  });

  it('says on every current row whether it needs a check', async () => {
    const live = await read(w, 'live');
    const why = Object.fromEntries(live.items.map((e) => [e.sourceRef, e.needsCheck]));
    expect(why['checked-lately']).toEqual([]);
    expect(why.fresh).toEqual([]);
    expect(why['cites-settled']).toEqual([]);
    expect(why['never-checked']).toEqual(['unchecked']);
  });

  it('counts each list by the same rule, whichever list is read', async () => {
    const counts = { live: 7, stale: 4, retired: 1 };
    expect((await read(w, 'live')).counts).toEqual(counts);
    expect((await read(w, 'stale')).counts).toEqual(counts);
    expect((await read(w, 'retired')).counts).toEqual(counts);
  });

  it('stops counting a memory once someone checks it', async () => {
    await db.execute(sql`
      UPDATE memories SET last_verified_at = now()
       WHERE project_id = ${w.projectId} AND source_ref = 'never-checked'
    `);
    const stale = await read(w, 'stale');
    expect(stale.items.map((e) => e.sourceRef)).not.toContain('never-checked');
    expect(stale.counts.stale).toBe(3);
  });
});
