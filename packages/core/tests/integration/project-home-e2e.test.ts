import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import {
  ago,
  DAY,
  feedback,
  issue,
  requirement,
  type World,
  world,
} from '../helpers/forecast-world.js';

// The project home's one read (REQ-43 BC-14..BC-18): every figure it answers equals what the list
// behind it lists — Requirements, Issues, Releases, Debt, Feedback and Needs you — on seeded rows,
// because it counts those lists' own reads rather than reading the tables a second way (L-57).
// @direct-test-of packages/core/src/project-status/home.ts
// @direct-test-of packages/core/src/project-status/routes.ts

const get = async (w: World, path: string): Promise<Body> => {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

/** A release run the Releases read lists: cut by the release batch, shipped at `at`. */
async function shipRelease(w: World, issueIds: readonly string[], at: Date): Promise<void> {
  w.versions += 1;
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${w.projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${`0.0.${w.versions}`}, ${at.toISOString()}, ${JSON.stringify({ issueIds, source: 'release-batch' })}::jsonb)
  `);
}

const countOf = (list: { key: string; count: number }[], key: string) =>
  list.find((c) => c.key === key)?.count ?? 0;

describe('the project home read', () => {
  let w: World;
  let home: Body;

  beforeAll(async () => {
    w = await world();
    const done = await issue(w, { status: 'closed', createdAt: ago(80), mergedAt: ago(70) });
    const older = await issue(w, { status: 'closed', createdAt: ago(60), mergedAt: ago(50) });
    await shipRelease(w, [done.id], new Date(Date.now() - 20 * DAY));
    await shipRelease(w, [older.id], ago(40));
    await shipRelease(w, [done.id, older.id], ago(2));
    await requirement(w, 'The board exports to a sheet');
    const dropped = await requirement(w, 'The board prints');
    // a seed names its transaction the kernel's, as the status guard asks of every status write
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
      await tx.execute(sql`UPDATE requirements SET status = 'dropped' WHERE id = ${dropped.id}`);
    });
    await issue(w, { status: 'open', createdAt: ago(3) });
    await issue(w, { status: 'in_progress', createdAt: ago(3) });
    await issue(w, { status: 'on_hold', createdAt: ago(5) });
    await issue(w, { status: 'awaiting_release', createdAt: ago(4), mergedAt: ago(1) });
    await feedback(w);
    await feedback(w);
    const recorded = await api(w.token, 'POST', `/api/projects/${w.projectId}/debts`, {
      items: [
        {
          kind: 'debt',
          where: 'packages/core/src/issues/standing.ts',
          detail: 'two reads of one fact',
          impact: { type: 'logic', rating: 'low', reason: 'a read, nothing written' },
        },
        {
          kind: 'simplify',
          where: 'packages/core/src/issues/standing.ts (rows)',
          detail: 'a helper folds into its caller',
          impact: { type: 'logic', rating: 'medium', reason: 'a read' },
        },
        {
          kind: 'red',
          check: 'verify',
          where: 'scripts/check-copy-budget.mjs',
          detail: 'copy budget over by 12 lines',
          impact: { type: 'config', rating: 'low', reason: 'a budget gate' },
        },
      ],
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBeLessThan(300);
    home = await get(w, '/home?tz=Asia/Ho_Chi_Minh');
  }, 120_000);

  it('counts open issues as the Issues page does, by status, with what runs on them', async () => {
    const list = await get(w, '/issues/standing?scope=open');
    const rows = list.issues as Body[];
    const delivery = home.delivery as Body;
    expect(delivery.open).toBe((list.counts as Body).open);
    const byStatus = delivery.byStatus as { key: string; count: number }[];
    for (const status of ['open', 'in_progress', 'on_hold', 'awaiting_release']) {
      expect(countOf(byStatus, status), status).toBe(
        rows.filter((r) => r.status === status).length,
      );
    }
    expect(byStatus.reduce((n, b) => n + b.count, 0)).toBe(delivery.open);
    expect((delivery.issues as Body[]).map((i) => i.key).sort()).toEqual(
      rows.map((r) => r.key).sort(),
    );
    expect(delivery.running).toBe(rows.filter((r) => (r.standing as Body).inFlight).length);
  });

  it('counts requirements in play as the Requirements page does, and proven criteria as the status report', async () => {
    const list = (await get(w, '/requirements')).requirements as Body[];
    const playing = list.filter((r) => !['dropped', 'refused'].includes(r.status as string));
    const product = home.product as Body;
    expect(product.requirements).toBe(playing.length);
    expect(product.requirements).toBeLessThan(list.length);
    const byState = product.byState as { key: string; count: number }[];
    for (const r of playing) {
      const state = (r.standing as Body).state as string;
      expect(countOf(byState, state), state).toBe(
        playing.filter((p) => (p.standing as Body).state === state).length,
      );
    }
    const status = (await get(w, '/status')).requirements as Body;
    expect(product.criteria).toEqual({ proven: status.proven, total: status.total });
  });

  it('counts releases shipped in 14 days from the Releases page, and names the newest', async () => {
    const releases = (await get(w, '/releases')).releases as Body[];
    const shipped = releases
      .filter((r) => r.state === 'shipped' && r.releasedAt)
      .sort((a, b) => String(b.releasedAt).localeCompare(String(a.releasedAt)));
    const release = home.release as Body;
    const days = release.days as { day: string; releases: number; issues: number }[];
    expect(days).toHaveLength(14);
    expect(release.shipped).toBe(2);
    expect(days.reduce((n, d) => n + d.releases, 0)).toBe(release.shipped);
    expect(days.reduce((n, d) => n + d.issues, 0)).toBe(release.issues);
    expect(release.issues).toBe(3);
    expect((release.timeline as Body[]).map((r) => r.version)).toEqual(
      shipped
        .slice(0, 2)
        .reverse()
        .map((r) => r.version),
    );
    expect((release.recent as Body[]).map((r) => r.version)).toEqual(
      shipped.slice(0, 3).map((r) => r.version),
    );
  });

  it('counts open findings as the debt ledger lists them, by kind, rating and place', async () => {
    const ledger = await get(w, '/debts');
    const audit = home.audit as Body;
    expect(audit.open).toBe((ledger.open as Body[]).length);
    expect(audit.cleared).toBe((ledger.cleared as Body[]).length);
    expect(audit.byKind).toEqual([
      { key: 'red', count: 1 },
      { key: 'debt', count: 1 },
      { key: 'simplify', count: 1 },
    ]);
    expect(audit.byRating).toEqual([
      { key: 'low', count: 2 },
      { key: 'medium', count: 1 },
    ]);
    const cells = audit.cells as Body[];
    expect(cells.reduce((n, c) => n + (c.count as number), 0)).toBe(audit.open);
    expect(cells.find((c) => c.type === 'logic' && c.kind === 'debt')?.places).toEqual([
      { where: 'standing.ts', count: 1 },
    ]);
  });

  it('counts open feedback as the Feedback page lists it, and this week holds what was reported', async () => {
    const list = (await get(w, '/feedback')).feedback as Body[];
    const open = list.filter((f) => !['done', 'declined'].includes(f.chip as string));
    expect((home.product as Body).feedbackOpen).toBe(open.length);
    const weeks = (home.feedback as Body).weeks as Body[];
    expect(weeks).toHaveLength(6);
    expect(weeks.at(-1)).toMatchObject({ open: 2, fixed: 0, declined: 0 });
  });

  it('carries the one Needs you number', async () => {
    const decisions = await get(w, '/needs-you/decisions');
    expect((home.needsYou as Body).total).toBe(decisions.total);
  });

  it('refuses a zone it cannot count days in, and a key it does not read, by name', async () => {
    const zone = await api(w.token, 'GET', `/api/projects/${w.projectId}/home?tz=Mars/Base`);
    expect(zone.status).toBe(400);
    expect(JSON.stringify(zone.body)).toContain('tz?');
    const key = await api(w.token, 'GET', `/api/projects/${w.projectId}/home?days=7`);
    expect(key.status).toBe(400);
  });
});
