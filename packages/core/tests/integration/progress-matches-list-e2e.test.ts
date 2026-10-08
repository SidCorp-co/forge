import { ROADMAP_HORIZON_OF } from '@forge/contracts/project-status';
import type { RequirementState } from '@forge/contracts/requirements';
import { UTC_READING } from '@forge/contracts/visual-blocks';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { app } from '../../src/index.js';
import { api, type Body } from '../helpers/api.js';
import {
  ago,
  issue,
  landHistory,
  MINUTE,
  requirement,
  shipRelease,
  type World,
  world,
} from '../helpers/forecast-world.js';
import { seedProductionDeployTrigger } from '../helpers/release-world.js';

// REQ-33 BC-3, ISS-433 criterion 2: the progress report (the PROGRESS template's
// progress-by-requirement query) and the Requirements list, read at one moment, give the same
// figures: the same requirements, every lane Later included, each on the same lane, with the same
// dates the list's ETA cell shows, and a plain "no forecast" where the list shows none. "One moment"
// holds because both read one simulation anchored on the last event, and none happens between.

/** A requirement moved to `status` on a current revision 1, inside the kernel's own transaction. */
async function seeded(w: World, title: string, status: 'agreed' | 'deferred' | 'dropped') {
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

const get = async (w: World, path: string): Promise<Body> => {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

/** The dates the list's ETA cell shows (`web-v2 forecast/eta.ts:etaOfDelivery`): in hands, else the landing range, else none. */
function listDates(d: Body | null | undefined): { p50At: string; p85At: string } | null {
  if (!d || d.shipped) return null;
  const hands = d.inHands as Body | null;
  if (hands) return { p50At: hands.p50At as string, p85At: hands.p85At as string };
  const landing = d.landing as Body;
  if (landing.kind === 'forecast')
    return { p50At: landing.p50At as string, p85At: landing.p85At as string };
  return null;
}

interface Seeds {
  now: string;
  next: string;
  laterLinked: string;
  laterBare: string;
  deferred: string;
  dropped: string;
}

/** A project with history, and a requirement on each lane, off it, linked and bare. */
async function seedWorld(w: World, onLand: boolean): Promise<Seeds> {
  if (onLand) await seedProductionDeployTrigger(w.projectId, w.userId, 'on-land');
  for (const h of await landHistory(w, 12)) {
    await shipRelease(w, [h.id], new Date(h.mergedAt.getTime() + 30 * MINUTE));
  }
  const now = await seeded(w, 'The board keeps its cards', 'agreed');
  await issue(w, { status: 'in_progress', createdAt: ago(3), requirementId: now.id });
  await issue(w, { status: 'open', createdAt: ago(2), requirementId: now.id });
  const next = await seeded(w, 'The board sorts by owner', 'agreed');
  const laterLinked = await requirement(w, 'The board exports to a sheet');
  await issue(w, { status: 'open', createdAt: ago(1), requirementId: laterLinked.id });
  const laterBare = await requirement(w, 'The board prints');
  const deferred = await seeded(w, 'The board syncs offline', 'deferred');
  const dropped = await seeded(w, 'The board plays sounds', 'dropped');
  return {
    now: now.key,
    next: next.key,
    laterLinked: laterLinked.key,
    laterBare: laterBare.key,
    deferred: deferred.key,
    dropped: dropped.key,
  };
}

/** The list (rows and their forecasts) and the report, read back to back with no event between. */
async function bothViews(w: World) {
  const list = (await get(w, '/requirements')).requirements as Body[];
  const forecasts = (await get(w, '/forecast/requirements')).requirements as Body[];
  const res = await api(
    w.token,
    'POST',
    `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows = (res.body.frame as Body).rows as Body[];
  return { list, forecasts, rows };
}

function expectSameFigures(views: Awaited<ReturnType<typeof bothViews>>) {
  const { list, forecasts, rows } = views;
  expect(rows.map((r) => r.key).sort()).toEqual(list.map((r) => r.key).sort());
  for (const r of list) {
    const row = rows.find((x) => x.key === r.key) as Body;
    const state = (r.standing as Body).state as RequirementState;
    const scope = forecasts.find((f) => f.key === r.key);
    const coverage = (r.delivery as Body).criteriaCoverage as Body;
    expect(row.state, String(r.key)).toBe(state);
    expect(row.lane, String(r.key)).toBe(ROADMAP_HORIZON_OF[state]);
    expect([row.criteriaProven, row.criteriaTotal], String(r.key)).toEqual([
      coverage.passing,
      coverage.criteria,
    ]);
    const progress = (scope?.progress as Body | undefined) ?? null;
    expect([row.shipped, row.awaitingRelease, row.toDo], String(r.key)).toEqual([
      progress?.shipped ?? 0,
      progress?.awaitingRelease ?? 0,
      progress?.toDo ?? 0,
    ]);
    const dates = listDates(scope?.delivery as Body | null | undefined);
    expect({ p50At: row.p50At, p85At: row.p85At }, String(r.key)).toEqual(
      dates ?? { p50At: null, p85At: null },
    );
    if (!dates) expect(String(row.basis), String(r.key)).toMatch(/^(no forecast|shipped)/);
  }
}

describe('the progress report and the Requirements list at one moment', () => {
  let auto: World;
  let byHand: World;
  let autoSeeds: Seeds;
  let byHandSeeds: Seeds;

  beforeAll(async () => {
    auto = await world();
    byHand = await world();
    autoSeeds = await seedWorld(auto, true);
    byHandSeeds = await seedWorld(byHand, false);
  }, 180_000);

  it('where production releases on land, reads the same requirements, lanes and dates in hands', async () => {
    const views = await bothViews(auto);
    expectSameFigures(views);
    const row = (key: string) => views.rows.find((r) => r.key === key) as Body;
    expect(row(autoSeeds.now)).toMatchObject({ lane: 'now' });
    expect(row(autoSeeds.now).p50At).toEqual(expect.any(String));
    expect(String(row(autoSeeds.now).basis)).toMatch(/in people's hands/);
    expect(row(autoSeeds.next)).toMatchObject({ lane: 'next' });
  });

  it('where a person releases, reads the landing dates the list shows, and who releases after', async () => {
    const views = await bothViews(byHand);
    expectSameFigures(views);
    const now = views.rows.find((r) => r.key === byHandSeeds.now) as Body;
    expect(now.p50At).toEqual(expect.any(String));
    expect(String(now.basis)).toMatch(/^lands by then; then .+ to /);
  });

  it('carries the Later lane: a linked draft with its forecast, a bare one and a deferred one with "no forecast"', async () => {
    const { rows } = await bothViews(auto);
    const row = (key: string) => rows.find((r) => r.key === key) as Body;
    expect(row(autoSeeds.laterLinked)).toMatchObject({ lane: 'later', state: 'draft' });
    expect(row(autoSeeds.laterLinked).p50At).toEqual(expect.any(String));
    expect(row(autoSeeds.laterBare)).toMatchObject({
      lane: 'later',
      p50At: null,
      p85At: null,
      basis: 'no forecast: nothing is linked to it yet',
    });
    expect(row(autoSeeds.deferred)).toMatchObject({ lane: 'later', state: 'deferred' });
    expect(row(autoSeeds.dropped)).toMatchObject({
      lane: null,
      state: 'dropped',
      p50At: null,
      basis: 'no forecast: dropped',
    });
  });

  it('keeps only the asked state, the same rows the list holds in it', async () => {
    const res = await api(
      auto.token,
      'POST',
      `/api/projects/${auto.projectId}/report-queries/progress-by-requirement/runs`,
      { params: { state: 'draft' } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = (await get(auto, '/requirements')).requirements as Body[];
    const drafts = list.filter((r) => (r.standing as Body).state === 'draft').map((r) => r.key);
    expect(((res.body.frame as Body).rows as Body[]).map((r) => r.key).sort()).toEqual(
      drafts.sort(),
    );
  });

  // REQ-32 BC-17: an exported or stored text states its dates in UTC and says so; raw ISO never reaches a person.
  it('exports a saved progress report with its forecast dates and basis in UTC, never as raw ISO', async () => {
    const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const base = `/api/projects/${auto.projectId}`;
    const run = await api(auto.token, 'POST', `${base}/report-templates/progress/runs`, {});
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(String(run.body.text)).not.toMatch(ISO);
    const runIds = ((run.body.document as Body).runs as Body[]).map((r) => String(r.runId));
    const saved = await api(auto.token, 'POST', `${base}/status/reports`, {
      templateId: 'progress',
      runIds,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const id = String(saved.body.id);
    const document = (await get(auto, `/status/reports/${id}`)).document as Body;
    const blocks = document.blocks as Body[];
    const index = blocks.findIndex(
      (b) => b.kind === 'table' && (b.columns as string[]).includes('p50At'),
    );
    expect(index, 'the progress report holds a table with a date column').toBeGreaterThanOrEqual(0);
    const rows = ((blocks[index] as Body).frame as Body).rows as Body[];
    const dated = rows.find((r) => typeof r.p50At === 'string') as Body;
    const reading = UTC_READING.instant(String(dated.p50At));
    expect(reading).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC$/);

    const md = await api(auto.token, 'GET', `${base}/status/reports/${id}/export`);
    const text = String(md.body.text ?? md.body);
    expect(text).not.toMatch(ISO);
    expect(text).toContain(reading);

    const csv = await app.fetch(
      new Request(
        `http://forge.test${base}/status/reports/${id}/export?format=csv&block=${index}`,
        {
          headers: { authorization: `Bearer ${auto.token}` },
        },
      ),
    );
    expect(csv.status).toBe(200);
    const csvText = await csv.text();
    expect(csvText).not.toMatch(ISO);
    expect(csvText).toContain(reading);
  });
});
