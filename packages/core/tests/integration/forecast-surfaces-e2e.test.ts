import { beforeAll, describe, expect, it } from 'vitest';
import type { Body } from '../helpers/api.js';
import {
  ago,
  DAY,
  declaredRun,
  feedback,
  issue,
  landHistory,
  MINUTE,
  moved,
  read,
  requirement,
  shipRelease,
  type World,
  world,
} from '../helpers/forecast-world.js';
import { seedProductionDeployTrigger } from '../helpers/release-world.js';

// "Done" as a person means it: in their hands. Feedback, requirements and Releases read the landing
// forecast plus the release that follows it — a sampled lag where production releases on its own,
// the person and the act, with no date, where somebody cuts it.

const HISTORY = 20;
const LAG_MINUTES = 30;

/** A history whose every landing shipped `LAG_MINUTES` after it merged, one release each. */
async function shippedHistory(w: World): Promise<void> {
  for (const h of await landHistory(w, HISTORY)) {
    await shipRelease(w, [h.id], new Date(h.mergedAt.getTime() + LAG_MINUTES * MINUTE));
  }
}

const byKey = (list: Body[], key: string) => {
  const found = list.find((x) => x.key === key);
  if (!found) throw new Error(`${key} is not in ${JSON.stringify(list.map((x) => x.key))}`);
  return found;
};

describe('feedback reads end to end where production releases on land', () => {
  let w: World;
  const fb = { untriaged: '', linked: '', fixed: '', shipped: '' };
  let shippedVersion = '';

  beforeAll(async () => {
    w = await world();
    await seedProductionDeployTrigger(w.projectId, w.userId, 'on-land');
    await shippedHistory(w);
    const open = await issue(w, { status: 'open', createdAt: ago(1) });
    const fixed = await issue(w, {
      status: 'awaiting_release',
      createdAt: ago(3),
      mergedAt: ago(0.1),
    });
    const doneAt = ago(26);
    const done = await issue(w, { status: 'closed', createdAt: ago(30), mergedAt: doneAt });
    shippedVersion = await shipRelease(
      w,
      [done.id],
      new Date(doneAt.getTime() + LAG_MINUTES * MINUTE),
    );
    fb.untriaged = await feedback(w);
    fb.linked = await feedback(w, [open.id]);
    fb.fixed = await feedback(w, [fixed.id]);
    fb.shipped = await feedback(w, [done.id]);
  }, 120_000);

  it('says an untriaged item waits on triage, naming who, with no date', async () => {
    const items = (await read(w, '/feedback')).items as Body[];
    const f = byKey(items, fb.untriaged);
    expect(f.triage).toMatchObject({ kind: 'paused', act: 'triage it' });
    expect(f.triage).not.toHaveProperty('p50At');
    expect(f.delivery).toBeNull();
  });

  it('ranges a linked item to people’s hands: the landing plus the sampled release lag', async () => {
    const f = byKey((await read(w, '/feedback')).items as Body[], fb.linked);
    const d = f.delivery as Body;
    const landing = d.landing as Body;
    expect(landing.kind).toBe('forecast');
    expect(d.release).toMatchObject({
      kind: 'automatic',
      basis: { n: HISTORY + 1, lagP50Minutes: LAG_MINUTES },
    });
    const inHands = d.inHands as Body;
    expect(inHands.p50Minutes).toBe((landing.p50Minutes as number) + LAG_MINUTES);
  });

  it('reads a fixed item still unreleased as the lag left, never as shipped', async () => {
    const d = byKey((await read(w, '/feedback')).items as Body[], fb.fixed).delivery as Body;
    expect((d.landing as Body).kind).toBe('landed');
    expect(d.shipped).toBeNull();
    const left = (d.inHands as Body).p50Minutes as number;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(LAG_MINUTES);
  });

  it('says a shipped item shipped, in its version and when', async () => {
    const d = byKey((await read(w, '/feedback')).items as Body[], fb.shipped).delivery as Body;
    expect(d.shipped).toMatchObject({ version: shippedVersion });
    expect(d.inHands).toBeNull();
  });
});

describe('a release a person cuts is named, never dated', () => {
  it('forecasts the landing, then names the admin and the version to cut', async () => {
    const w = await world();
    await seedProductionDeployTrigger(w.projectId, w.userId, 'on-request');
    await shippedHistory(w);
    const open = await issue(w, { status: 'open', createdAt: ago(1) });
    const key = await feedback(w, [open.id]);
    const d = byKey((await read(w, '/feedback')).items as Body[], key).delivery as Body;
    expect((d.landing as Body).kind).toBe('forecast');
    expect(d.release).toMatchObject({ kind: 'person', mode: 'manual', who: 'A project admin' });
    expect((d.release as Body).act).toMatch(/^cut \d+\.\d+\.\d+/);
    expect(d.inHands).toBeNull();
  });
});

describe('requirements list and what comes next on Releases', () => {
  let w: World;
  const req = { open: { id: '', key: '' }, landed: { id: '', key: '' } };

  beforeAll(async () => {
    w = await world();
    await seedProductionDeployTrigger(w.projectId, w.userId, 'on-land');
    await shippedHistory(w);
    req.open = await requirement(w, 'The board keeps its cards');
    req.landed = await requirement(w, 'The board loads fast');
    await issue(w, { status: 'open', createdAt: ago(2), requirementId: req.open.id });
    await issue(w, { status: 'open', createdAt: ago(1), requirementId: req.open.id });
    await issue(w, {
      status: 'awaiting_release',
      createdAt: ago(5),
      mergedAt: ago(0.2),
      requirementId: req.landed.id,
    });
  }, 120_000);

  it('gives every live requirement its end-to-end range on the list read', async () => {
    const list = (await read(w, '/requirements')).requirements as Body[];
    const open = byKey(list, req.open.key);
    expect(open).toMatchObject({ title: 'The board keeps its cards', total: 2, landed: 0 });
    expect(((open.delivery as Body).landing as Body).kind).toBe('forecast');
    expect((open.delivery as Body).inHands).not.toBeNull();
    expect(((byKey(list, req.landed.key).delivery as Body).landing as Body).kind).toBe('landed');
  });

  it('lists only the requirements with work still to land, and the draft release', async () => {
    const next = await read(w, '/releases/coming');
    const keys = (next.requirements as Body[]).map((r) => r.key);
    expect(keys).toEqual([req.open.key]);
    expect(next.draft).toMatchObject({ scope: 'release', key: 'draft', total: 1, landed: 1 });
    expect(((next.draft as Body).delivery as Body).release).toMatchObject({ kind: 'automatic' });
  });
});

describe('concurrency is held to the runs the project has had live at once, not to issue status', () => {
  it('works two lanes where seven issues stood in progress at once but never more than two runs were live', async () => {
    const w = await world();
    const t0 = Date.now() - 2 * DAY;
    for (let i = 0; i < HISTORY; i++) {
      // a burst of status: seven issues at a time sit at in_progress for a whole afternoon
      const started = new Date(t0 + Math.floor(i / 7) * 600 * MINUTE);
      const merged = new Date(started.getTime() + 600 * MINUTE);
      const { id } = await issue(w, {
        status: 'closed',
        createdAt: new Date(started.getTime() - MINUTE),
        mergedAt: merged,
      });
      await moved(w, id, 'open', 'in_progress', started);
      await moved(w, id, 'in_progress', 'developed', new Date(merged.getTime() - MINUTE));
    }
    // the box works them two at a time; one run is still open now
    for (let i = 0; i < 6; i++) {
      const start = new Date(t0 + i * 240 * MINUTE);
      await declaredRun(w, start, new Date(start.getTime() + 239 * MINUTE));
      await declaredRun(
        w,
        new Date(start.getTime() + 60 * MINUTE),
        new Date(start.getTime() + 200 * MINUTE),
      );
    }
    await declaredRun(w, ago(1), null);
    const queue = [];
    for (let i = 0; i < 4; i++)
      queue.push(await issue(w, { status: 'open', createdAt: ago(4 - i) }));
    const f = (await read(w, `/issues/${queue[3]?.key}`)).forecast as Body;
    expect(f.kind, JSON.stringify(f)).toBe('forecast');
    expect((f.basis as Body).concurrency, (f.basis as Body).concurrencyBasis as string).toBe(2);
    expect((f.basis as Body).concurrencyBasis).toMatch(/held to 2: the most runs live at once/);
  });

  it('is not held to a run count where no run was live in the window, and says so', async () => {
    const w = await world();
    await landHistory(w, HISTORY);
    const { key } = await issue(w, { status: 'open', createdAt: ago(1) });
    const f = (await read(w, `/issues/${key}`)).forecast as Body;
    expect(f.kind, JSON.stringify(f)).toBe('forecast');
    expect((f.basis as Body).concurrencyBasis).toMatch(/no run was live in the last 14 days/);
  });
});
