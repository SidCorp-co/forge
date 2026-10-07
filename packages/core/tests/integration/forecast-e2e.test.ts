import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// A forecast is a range read off the project's own history, through its queue at its own
// concurrency, and never a date where a person or an outage holds the work.

const MINUTE = 60_000;
const DAY = 86_400_000;
const HISTORY = 20;

interface World {
  projectId: string;
  userId: string;
  token: string;
  runnerId: string;
  deviceId: string;
  seq: number;
}

async function world(): Promise<World> {
  const user = await createTestUser({ verified: true });
  const project = await createTestProject(user.id);
  await addProjectMember(project.id, user.id, 'admin');
  const device = await createTestDevice(user.id);
  const runnerId = randomUUID();
  await db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, repo_path)
    VALUES (${runnerId}, ${project.id}, 'claude-code', ${device}, 'box', 'online', now(), '/srv/checkout')
  `);
  return {
    projectId: project.id,
    userId: user.id,
    token: await userToken(user.id),
    runnerId,
    deviceId: device,
    seq: 0,
  };
}

async function issue(
  w: World,
  over: {
    status: string;
    createdAt: Date;
    mergedAt?: Date | null;
    waitingKind?: string;
    priority?: string;
  },
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  w.seq += 1;
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, merged_at, waiting_kind, priority)
    VALUES (${id}, ${w.projectId}, ${w.seq}, ${`issue ${w.seq}`}, ${over.status}, ${w.userId},
            ${over.createdAt.toISOString()}, ${over.mergedAt?.toISOString() ?? null},
            ${over.waitingKind ?? null}, ${over.priority ?? 'medium'})
  `);
  return { id, key: `ISS-${w.seq}` };
}

/** `n` issues landed one a day, each `45..75` minutes from in_progress to merge (p50 59). */
async function landHistory(w: World, n: number): Promise<number[]> {
  const minutes: number[] = [];
  for (let i = 0; i < n; i++) {
    const took = 45 + Math.round((30 * i) / Math.max(1, n - 1));
    minutes.push(took);
    const merged = new Date(Date.now() - (n - i) * DAY);
    const started = new Date(merged.getTime() - took * MINUTE);
    const { id } = await issue(w, {
      status: 'closed',
      createdAt: new Date(started.getTime() - MINUTE),
      mergedAt: merged,
    });
    await db.execute(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
      VALUES (${id}, 'user', ${w.userId}, 'human', 'issue.statusChanged',
              ${JSON.stringify({ from: 'open', to: 'in_progress' })}::jsonb, ${started.toISOString()})
    `);
  }
  return minutes.sort((a, b) => a - b);
}

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function read(w: World, path: string): Promise<Body> {
  const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/forecast${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe('forecast read', () => {
  let w: World;
  let p50 = 0;
  const keys = { q1: '', q2: '', q3: '', target: '', parked: '', gated: '' };

  beforeAll(async () => {
    w = await world();
    const minutes = await landHistory(w, HISTORY);
    p50 = minutes[Math.ceil(0.5 * minutes.length) - 1] ?? 0;
    keys.q1 = (await issue(w, { status: 'open', createdAt: ago(4) })).key;
    keys.q2 = (await issue(w, { status: 'open', createdAt: ago(3) })).key;
    keys.q3 = (await issue(w, { status: 'open', createdAt: ago(2) })).key;
    keys.target = (await issue(w, { status: 'open', createdAt: ago(1) })).key;
    keys.parked = (
      await issue(w, { status: 'needs_info', createdAt: ago(5), waitingKind: 'needs_answer' })
    ).key;
    keys.gated = (
      await issue(w, { status: 'awaiting_release', createdAt: ago(6), mergedAt: ago(0.5) })
    ).key;
  }, 120_000);

  it('puts the issue behind three others at one lane near four cycles out, as a labelled range', async () => {
    const body = await read(w, `/issues/${keys.target}`);
    const f = body.forecast as Body;
    expect(f.kind, JSON.stringify(f)).toBe('forecast');
    expect(f.label).toBe('forecast');
    expect(f.ahead).toBe(3);
    expect(f.aheadKeys).toEqual([keys.q1, keys.q2, keys.q3]);
    expect(f.p50Minutes as number).toBeLessThanOrEqual(4 * p50 * 1.1);
    expect(f.p85Minutes as number).toBeGreaterThanOrEqual(4 * p50 * 0.9);
    expect(f.p85Minutes as number).toBeGreaterThanOrEqual(f.p50Minutes as number);
    expect(f.basis).toMatchObject({ n: HISTORY, floor: 10, concurrency: 1 });
    expect(typeof f.asOf).toBe('string');
  });

  it('says paused and who owes the move for a needs_info issue, with no date', async () => {
    const f = (await read(w, `/issues/${keys.parked}`)).forecast as Body;
    expect(f).toMatchObject({ kind: 'paused', who: 'A project writer', act: 'answer a question' });
    expect(f).not.toHaveProperty('p50At');
  });

  it('reads landed for an issue already merged, and lists every open issue on the board read', async () => {
    expect(((await read(w, `/issues/${keys.gated}`)).forecast as Body).kind).toBe('landed');
    const board = await read(w, '');
    const listed = (board.issues as Body[]).map((i) => i.key);
    expect(listed).toEqual(
      expect.arrayContaining([keys.q1, keys.q2, keys.q3, keys.target, keys.parked, keys.gated]),
    );
    expect(board.pause).toBeNull();
  });

  it('forecasts the draft release as landed once every issue it holds has', async () => {
    const draft = await read(w, '/releases/draft');
    expect(draft).toMatchObject({ scope: 'release', key: 'draft', total: 1, landed: 1 });
    expect((draft.forecast as Body).kind).toBe('landed');
  });

  it('pauses every open issue while no runner can take the work', async () => {
    await db.execute(
      sql`UPDATE runners SET last_seen_at = now() - interval '1 day' WHERE id = ${w.runnerId}`,
    );
    try {
      const f = (await read(w, `/issues/${keys.target}`)).forecast as Body;
      expect(f.kind).toBe('paused');
      expect(f.reason).toMatch(/no runner can take this project's work/);
      expect((await read(w, '')).pause).toMatchObject({ kind: 'paused' });
    } finally {
      await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE id = ${w.runnerId}`);
    }
  });

  it('refuses an issue the project does not hold by name', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/forecast/issues/ISS-999`);
    expect(res.status).toBe(404);
  });
});

describe('a merged mark on an open issue is not a landing', () => {
  it('forecasts an open issue carrying a mark as work, keeps it out of the history, and holds its dependent behind it', async () => {
    const w = await world();
    await landHistory(w, HISTORY);
    const marked = await issue(w, { status: 'open', createdAt: ago(2), mergedAt: ago(1) });
    await db.execute(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
      VALUES (${marked.id}, 'user', ${w.userId}, 'human', 'issue.statusChanged',
              ${JSON.stringify({ from: 'open', to: 'in_progress' })}::jsonb, ${ago(1.5).toISOString()})
    `);
    const dependent = await issue(w, { status: 'open', createdAt: ago(1) });
    await db.execute(sql`
      INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
      VALUES (${w.projectId}, ${marked.id}, ${dependent.id}, 'blocks')
    `);

    const f = (await read(w, `/issues/${marked.key}`)).forecast as Body;
    expect(f.kind, JSON.stringify(f)).toBe('forecast');
    expect(f.basis).toMatchObject({ n: HISTORY });
    const held = (await read(w, `/issues/${dependent.key}`)).forecast as Body;
    expect(held.kind, JSON.stringify(held)).toBe('forecast');
    expect(held.waitsOn).toEqual([marked.key]);
  });
});

describe('forecast below the history floor', () => {
  it('gives no number, only the sample size and the floor', async () => {
    const w = await world();
    await landHistory(w, 5);
    const { key } = await issue(w, { status: 'open', createdAt: ago(1) });
    const f = (await read(w, `/issues/${key}`)).forecast as Body;
    expect(f).toMatchObject({ kind: 'not_enough_history', n: 5, floor: 10, label: 'forecast' });
    expect(f).not.toHaveProperty('p50At');
  });
});

describe('dispatch order honours priority', () => {
  it('hands a newer high issue to the master before an older medium one, and forecasts it earlier', async () => {
    const w = await world();
    await landHistory(w, HISTORY);
    const older = await issue(w, { status: 'open', createdAt: ago(3), priority: 'medium' });
    const newer = await issue(w, { status: 'open', createdAt: ago(1), priority: 'high' });
    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    const listed = await readAdmissibleIssues({ deviceId: w.deviceId, projectId: w.projectId });
    expect(listed.items.map((i) => i.issueKey)).toEqual([newer.key, older.key]);
    const high = (await read(w, `/issues/${newer.key}`)).forecast as Body;
    const medium = (await read(w, `/issues/${older.key}`)).forecast as Body;
    expect(high).toMatchObject({ kind: 'forecast', ahead: 0 });
    expect(medium).toMatchObject({ kind: 'forecast', ahead: 1, aheadKeys: [newer.key] });
    expect(high.p50Minutes as number).toBeLessThan(medium.p50Minutes as number);
  });
});
