import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import {
  ago,
  issue,
  landHistory,
  MINUTE,
  requirement,
  type World,
  world,
} from '../helpers/forecast-world.js';

// One read of how a project stands (JU-1, JU-3, JU-4, JU-10): what shipped in the window, what is in
// flight, whom rows wait on, requirements' proven criteria, the draft release and Now/Next/Later —
// and the same numbers the dashboard's own reads give, because it is assembled from them.

/**
 * A requirement at `status` on a current revision 1, moved there inside a transaction that names
 * itself the kernel's, as a seed must: the guard refuses a status written by hand otherwise.
 */
async function seeded(w: World, title: string, status: 'agreed' | 'deferred') {
  const { id, key } = await requirement(w, title);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${id}, 1, 'current', ${JSON.stringify({ goal: title })}::jsonb, 'seed', ${w.userId}, 'human', ${w.userId}, now())
    `);
    await tx.execute(
      sql`UPDATE requirements SET status = ${status}, current_revision = 1 WHERE id = ${id}`,
    );
  });
  return { id, key };
}

/** A release run the Releases read lists: cut by the release batch, shipped at `at`. */
async function shipped(w: World, issueIds: readonly string[], at: Date): Promise<string> {
  w.versions += 1;
  const version = `0.0.${w.versions}`;
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    VALUES (gen_random_uuid(), ${w.projectId}, 'system', 'completed', ${at.toISOString()}, ${at.toISOString()},
            ${version}, ${at.toISOString()}, ${JSON.stringify({ issueIds, source: 'release-batch' })}::jsonb)
  `);
  return version;
}

const get = async (w: World, path: string): Promise<Body> => {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

describe('the project status read', () => {
  let w: World;
  let status: Body;
  const req = { drafted: '', agreed: '', deferred: '' };
  let lastVersion = '';
  let landed: Awaited<ReturnType<typeof issue>>;

  beforeAll(async () => {
    w = await world();
    const history = await landHistory(w, 12);
    for (const h of history) {
      lastVersion = await shipped(w, [h.id], new Date(h.mergedAt.getTime() + 30 * MINUTE));
    }
    req.drafted = (await requirement(w, 'The board exports to a sheet')).key;
    const agreed = await seeded(w, 'The board keeps its cards', 'agreed');
    req.agreed = agreed.key;
    await issue(w, { status: 'open', createdAt: ago(2), requirementId: agreed.id });
    await issue(w, { status: 'in_progress', createdAt: ago(3), requirementId: agreed.id });
    const deferred = await seeded(w, 'The board prints', 'deferred');
    req.deferred = deferred.key;
    await db.execute(sql`
      INSERT INTO requirement_deferrals (requirement_id, act, from_status, target_phase, reason, decided_by)
      VALUES (${deferred.id}, 'defer', 'draft', 'phase 2', 'printing waits for the new layout', ${w.userId})
    `);
    landed = await issue(w, { status: 'awaiting_release', createdAt: ago(4), mergedAt: ago(1) });
    status = await get(w, '/status?days=7');
  }, 120_000);

  it('lists the releases shipped inside the window, newest first, each saying what was verified', () => {
    const shipped = status.shipped as Body;
    const releases = shipped.releases as Body[];
    expect(shipped.releaseCount).toBe(releases.length);
    expect(releases.length).toBeGreaterThanOrEqual(6);
    expect(releases.length).toBeLessThanOrEqual(8);
    expect(releases[0]?.version).toBe(lastVersion);
    const since = Date.parse(shipped.since as string);
    for (const r of releases)
      expect(Date.parse(r.releasedAt as string)).toBeGreaterThanOrEqual(since);
    expect(releases[0]?.verified).toMatchObject({ level: 'none', proven: 0, total: 0 });
    expect(shipped.issueCount).toBe(releases.length);
  });

  it('a one-day window holds only the release of the last day', async () => {
    const day = (await get(w, '/status?days=1')).shipped as Body;
    expect((day.releases as Body[]).map((r) => r.version)).toEqual([lastVersion]);
    expect((day.latest as Body).version).toBe(lastVersion);
  });

  it('places each requirement by its state: in delivery now, agreed next, deferred and drafts later', async () => {
    const list = (await get(w, '/requirements')).requirements as Body[];
    const stateOf = (key: string) =>
      (list.find((r) => r.key === key)?.standing as Body | undefined)?.state;
    const roadmap = status.roadmap as Body;
    const where = (key: string) =>
      (['now', 'next', 'later'] as const).find((h) =>
        (roadmap[h] as Body[]).some((i) => i.key === key),
      );
    const expected = { in_delivery: 'now', agreed: 'next', deferred: 'later', draft: 'later' };
    for (const key of [req.drafted, req.agreed, req.deferred]) {
      expect(where(key), key).toBe(expected[stateOf(key) as keyof typeof expected]);
    }
    const later = roadmap.later as Body[];
    expect(later[0]).toMatchObject({
      key: req.deferred,
      deferral: { reason: 'printing waits for the new layout', targetPhase: 'phase 2' },
    });
    expect(later.at(-1)?.key).toBe(req.drafted);
  });

  it('reads the numbers the dashboard reads: requirements by state, needs-you, the draft release', async () => {
    const list = (await get(w, '/requirements')).requirements as Body[];
    const byState = (status.requirements as Body).byState as { state: string; count: number }[];
    for (const { state, count } of byState) {
      expect(count, state).toBe(list.filter((r) => (r.standing as Body).state === state).length);
    }
    const needsYou = await get(w, '/needs-you');
    const asks = (needsYou.items as Body[]).filter((i) => i.space === 'asks');
    expect((status.waits as Body).needsYou).toBe(needsYou.asks);
    expect(needsYou.asks).toBe(asks.length);
    const releases = (await get(w, '/releases')).releases as Body[];
    const draft = releases.find((r) => r.state === 'draft');
    expect((status.nextRelease as Body).version).toBe(draft?.version ?? null);
    const coming = await get(w, '/forecast/releases/coming');
    expect((status.nextRelease as Body).progress).toEqual((coming.draft as Body).progress);
    expect(((status.nextRelease as Body).progress as Body).total).toBe(draft?.issueCount);
    const forecasts = (await get(w, '/forecast/requirements')).requirements as Body[];
    for (const r of (status.requirements as Body).items as Body[]) {
      expect(r.progress, String(r.key)).toEqual(forecasts.find((f) => f.key === r.key)?.progress);
    }
  });

  it('counts open work by status and names what a run is on', () => {
    const inFlight = status.inFlight as Body;
    const by = Object.fromEntries(
      (inFlight.byStatus as { status: string; count: number }[]).map((b) => [b.status, b.count]),
    );
    expect(by).toMatchObject({ open: 1, in_progress: 1, awaiting_release: 1 });
    expect(inFlight.truncated).toBe(false);
  });

  it('dates every section with the moment its read answered', () => {
    const asOf = Date.parse(status.asOf as string);
    for (const section of [
      'shipped',
      'inFlight',
      'waits',
      'requirements',
      'nextRelease',
      'late',
      'roadmap',
    ]) {
      const at = Date.parse((status[section] as Body).asOf as string);
      expect(Number.isNaN(at), section).toBe(false);
      expect(at, section).toBeGreaterThanOrEqual(asOf - 60_000);
    }
  });

  it('names a release already cut as the next one, before any draft, with whose turn moves it', async () => {
    w.versions += 1;
    const version = `0.0.${w.versions}`;
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (gen_random_uuid(), ${w.projectId}, 'system', 'running', now(), ${version},
              ${JSON.stringify({ issueIds: [landed.id], source: 'release-batch' })}::jsonb)
    `);
    const next = (await get(w, '/status?days=7')).nextRelease as Body;
    const rows = (await get(w, '/releases')).releases as Body[];
    const row = rows.find((r) => r.version === version);
    expect(row?.state).toBe('in_progress');
    expect(next.version).toBe(version);
    expect(next.state).toBe(row?.state);
    expect(next.progress).toEqual({ total: 1, shipped: 0, awaitingRelease: 1, toDo: 0 });
    expect(next.forecast).toBeNull();
    // the draft behind it is the Releases read's own draft row, said only while it holds issues
    const draft = rows.find((r) => r.state === 'draft');
    expect(next.behind).toEqual(
      draft && Number(draft.issueCount) > 0
        ? { version: draft.version, issueCount: draft.issueCount }
        : null,
    );
  });

  it('refuses a window it cannot read, by name', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/status?days=0`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('days?');
  });
});
