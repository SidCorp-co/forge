// A module's standing and full page, read through the real routes over a real database: the roll-up of a
// child into its parent, what is open and what has landed, and the facts that have no data saying so.

import type { ModuleDetail, ModuleRollupResponse } from '@forge/contracts/modules';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { installModuleAxisFixture } from '../helpers/module-axis-fixture.js';

const fx = installModuleAxisFixture();

async function seed() {
  const outreach = await fx.defineModule('outreach');
  const zalo = await fx.defineModule('zalo', { parentId: outreach.id });
  const quiet = await fx.defineModule('reports');
  const open = await fx.createIssue('Reminder schedule');
  const landed = await fx.createIssue('Template editor');
  const refused = await fx.setLabels(open, [{ labelId: zalo.id, isPrimary: true }]);
  expect(fx.refusalText(refused)).toBeNull();
  await fx.setLabels(landed, [{ labelId: zalo.id, isPrimary: true }]);
  await fx.db().db.execute(sql`UPDATE issues SET status = 'open' WHERE id = ${open}`);
  await fx
    .db()
    .db.execute(
      sql`UPDATE issues SET status = 'closed', merged_at = now() - interval '2 days' WHERE id = ${landed}`,
    );
  return { outreach, zalo, quiet };
}

describe('GET /modules/rollup with standing', () => {
  it('rolls a child up into its parent and reads the last landing, with nothing invented for a quiet module', async () => {
    await seed();
    const res = await fx.get('/modules/rollup');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModuleRollupResponse;
    const row = (name: string) => body.modules.find((m) => m.name === name);
    expect(row('zalo')?.standing.open).toBe(1);
    expect(row('outreach')?.standing.open).toBe(1);
    expect(row('outreach')?.standing.childCount).toBe(1);
    expect(row('outreach')?.standing.lastLanding?.title).toBe('Template editor');
    expect(row('reports')?.standing.attentionGroup).toBe('quiet');
    expect(row('reports')?.standing.lastLanding).toBeNull();
    expect(body.issuesRead.open).toBeGreaterThanOrEqual(1);
  });

  it('keeps an archived issue out of every count and landing', async () => {
    const { zalo } = await seed();
    await fx.db().db.execute(sql`UPDATE issues SET archived_at = now()`);
    const body = (await (await fx.get('/modules/rollup')).json()) as ModuleRollupResponse;
    const row = body.modules.find((m) => m.id === zalo.id);
    expect(row?.standing.open).toBe(0);
    expect(row?.standing.lastLanding).toBeNull();
  });
});

describe('GET /modules/rollup counts open the way the Issues list does (ISS-69)', () => {
  it('counts awaiting_release and draft as open, closed only when shipped, dropped apart', async () => {
    const zalo = await fx.defineModule('zalo');
    const at = async (title: string, status: string, moduleId: string | null) => {
      const id = await fx.createIssue(title);
      if (moduleId) await fx.setLabels(id, [{ labelId: moduleId, isPrimary: true }]);
      await fx
        .db()
        .db.execute(
          sql`UPDATE issues SET status = ${status}, merged_at = CASE WHEN ${status} = 'closed' THEN now() ELSE merged_at END WHERE id = ${id}`,
        );
    };
    await at('Waits on release', 'awaiting_release', zalo.id);
    await at('Not admitted', 'draft', zalo.id);
    await at('Shipped', 'closed', zalo.id);
    await at('Not work', 'dropped', zalo.id);
    await at('Loose and released', 'awaiting_release', null);
    await at('Loose and dropped', 'dropped', null);

    const body = (await (await fx.get('/modules/rollup')).json()) as ModuleRollupResponse;
    const own = body.modules.find((m) => m.id === zalo.id)?.own.primary;
    expect(own).toMatchObject({ total: 4, open: 2, closed: 1, dropped: 1 });
    expect(body.unassigned).toMatchObject({ total: 2, open: 1, closed: 0, dropped: 1 });
    expect((own?.open ?? 0) + body.unassigned.open).toBe(body.issuesRead.open);
  });
});

describe('GET /modules/:module/detail', () => {
  it('reads one module by slug with its parent, landings and the facts nothing records', async () => {
    await seed();
    const res = await fx.get('/modules/zalo/detail');
    expect(res.status).toBe(200);
    const d = (await res.json()) as ModuleDetail;
    expect(d.module.parent?.name).toBe('outreach');
    expect(d.landings.total).toBe(1);
    expect(d.landings.recent[0]?.title).toBe('Template editor');
    expect(d.issues.map((i) => i.title)).toEqual(['Reminder schedule']);
    expect(d.activity.days).toHaveLength(14);
    expect(d.purpose).toEqual({
      available: false,
      reason: 'no knowledge entry is linked to this module',
    });
    expect(d.keyPaths.available).toBe(false);
    expect(d.owner.available).toBe(false);
    expect(d.contracts.available).toBe(false);
  });

  it('lists a parent’s children and counts what is open under them', async () => {
    await seed();
    const d = (await (await fx.get('/modules/outreach/detail')).json()) as ModuleDetail;
    expect(d.module.children.map((c) => c.name)).toEqual(['zalo']);
    expect(d.standing.open).toBe(1);
  });

  it('refuses an unknown module by name with a 404', async () => {
    await seed();
    const res = await fx.get('/modules/nope/detail');
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain('nope');
  });

  it('does not read "rollup" or "drift" as a module slug', async () => {
    await seed();
    expect((await fx.get('/modules/rollup')).status).toBe(200);
    expect((await fx.get('/modules/drift')).status).toBe(200);
  });
});
