/**
 * ISS-1229 r16 — judge-41 found the stuck-issue notices of a live project held for ever: a firing
 * pipeline wedge holds every one of its project (`INHIBIT_RULES`), and the re-evaluation ended a
 * wedge only when its key named a finished job or pipeline run, so one keyed on a session ("claim hop
 * miss on session", its session failed) never ended. Every key kind now has its resolver, a key no
 * resolver reads is refused where it is raised, and the notices already held go out on the next pass.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let reevaluate: (now: Date) => Promise<{ resolved: number; released: number }>;
let emitPipelineWedge: typeof import('../../src/pipeline/wedge.js').emitPipelineWedge;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  reevaluate = (await import('../../src/pipeline/reevaluate-conditions.js')).reevaluateConditions;
  emitPipelineWedge = (await import('../../src/pipeline/wedge.js')).emitPipelineWedge;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type World = { ownerId: string; projectId: string; issueId: string };

async function world(): Promise<World> {
  const owner = await createTestUser(harness.db);
  const org = await seedOrg(harness.db, owner.id);
  const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, waiting_kind)
    VALUES (${issueId}::uuid, ${project.id}::uuid, 'parked', 'waiting', ${owner.id}::uuid, 1, 'needs_decision')
  `);
  return { ownerId: owner.id, projectId: project.id, issueId };
}

/** A firing wedge on `key`, and the issue's stuck-issue notice it holds. */
async function wedgeHolding(w: World, key: string): Promise<{ wedgeId: string; heldId: string }> {
  const [wedge] = (await harness.db.execute(sql`
    INSERT INTO notifications (project_id, type, kind, tier, state, title, resolution_key, pending_since, last_seen_at)
    VALUES (${w.projectId}::uuid, 'pipeline_wedge', 'condition', 'page', 'firing',
            'Pipeline wedge: claim hop miss on session', ${key}, now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [held] = (await harness.db.execute(sql`
    INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                               inhibited_by, pending_since, last_seen_at)
    VALUES (${w.projectId}::uuid, ${w.issueId}::uuid, 'issue_stranded', 'condition', 'ticket',
            'inhibited', 'held', ${`issue:${w.issueId}:stranded`}, ${wedge?.id}::uuid, now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { wedgeId: wedge?.id ?? '', heldId: held?.id ?? '' };
}

async function stateOf(id: string): Promise<{ state: string; resolved: boolean }> {
  const [row] = (await harness.db.execute(sql`
    SELECT state, resolved_at IS NOT NULL AS resolved FROM notifications WHERE id = ${id}::uuid
  `)) as unknown as Array<{ state: string; resolved: boolean }>;
  if (!row) throw new Error(`no notification ${id}`);
  return row;
}

async function session(w: World, status: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status)
    VALUES (${id}::uuid, ${w.projectId}::uuid, ${await run(w, 'running')}::uuid, 'pipeline', ${status})
  `);
  return id;
}

async function job(w: World, status: string, type = 'drive'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by)
    VALUES (${id}::uuid, ${w.projectId}::uuid, ${w.issueId}::uuid, ${await run(w, 'running')}::uuid,
            ${type}, ${status}, ${w.ownerId}::uuid)
  `);
  return id;
}

async function run(w: World, status: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${id}::uuid, ${w.projectId}::uuid, ${w.issueId}::uuid, 'issue', ${status}, now())
  `);
  return id;
}

async function runner(
  w: World,
  faulted: { auth?: boolean; quarantinedFor?: number },
): Promise<string> {
  const device = await createTestDevice(harness.db, w.ownerId);
  const id = randomUUID();
  const until =
    faulted.quarantinedFor === undefined
      ? null
      : new Date(Date.now() + faulted.quarantinedFor).toISOString();
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, limit_reason, quarantined_until)
    VALUES (${id}::uuid, ${w.projectId}::uuid, 'claude-code', ${device.id}::uuid, ${`r-${id.slice(0, 8)}`},
            'online', ${faulted.auth ? 'auth' : null}, ${until}::timestamptz)
  `);
  return id;
}

async function outbox(w: World, processed: boolean): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_outbox (id, issue_id, project_id, from_status, to_status, processed_at)
    VALUES (${id}::uuid, ${w.issueId}::uuid, ${w.projectId}::uuid, 'open', 'in_progress',
            ${processed ? new Date().toISOString() : null}::timestamptz)
  `);
  return id;
}

describe('a session-keyed wedge, the one judge-41 saw holding a live board', () => {
  it('ends once its session has failed, and the notice it held goes out on the same pass', async () => {
    const w = await world();
    const sessionId = await session(w, 'failed');
    const { wedgeId, heldId } = await wedgeHolding(w, `wedge:${sessionId}`);

    const result = await reevaluate(new Date());

    expect(await stateOf(wedgeId)).toEqual({ state: 'resolved', resolved: true });
    expect(await stateOf(heldId)).toEqual({ state: 'pending', resolved: false });
    expect(result.released).toBe(1);
  });

  it('holds while its session is still running', async () => {
    const w = await world();
    const sessionId = await session(w, 'running');
    const { wedgeId, heldId } = await wedgeHolding(w, `wedge:${sessionId}`);

    await reevaluate(new Date());

    expect(await stateOf(wedgeId)).toEqual({ state: 'firing', resolved: false });
    expect(await stateOf(heldId)).toEqual({ state: 'inhibited', resolved: false });
  });

  it('ends once its session is gone', async () => {
    const w = await world();
    const { wedgeId, heldId } = await wedgeHolding(w, `wedge:${randomUUID()}`);

    await reevaluate(new Date());

    expect((await stateOf(wedgeId)).resolved).toBe(true);
    expect((await stateOf(heldId)).state).toBe('pending');
  });
});

describe('every other key kind ends with its subject and holds while it stands', () => {
  const cases: Array<{
    kind: string;
    live: (w: World) => Promise<string>;
    over: (w: World) => Promise<string>;
  }> = [
    {
      kind: 'job',
      live: async (w) => `wedge:${await job(w, 'running')}`,
      over: async (w) => `wedge:${await job(w, 'failed')}`,
    },
    {
      kind: 'auth-dead runner',
      live: async (w) => `wedge:${await runner(w, { auth: true })}`,
      over: async (w) => `wedge:${await runner(w, {})}`,
    },
    {
      kind: 'quarantined runner',
      live: async (w) => `wedge:${await runner(w, { quarantinedFor: 60 * 60_000 })}`,
      over: async (w) => `wedge:${await runner(w, { quarantinedFor: -60_000 })}`,
    },
    {
      kind: 'outbox',
      live: async (w) => `wedge:${await outbox(w, false)}`,
      over: async (w) => `wedge:${await outbox(w, true)}`,
    },
    {
      kind: 'paused run',
      live: async (w) => `wedge:paused:${await run(w, 'paused')}`,
      over: async (w) => `wedge:paused:${await run(w, 'running')}`,
    },
    {
      kind: 'review rounds',
      live: async (w) => `wedge:rounds:${await run(w, 'running')}`,
      over: async (w) => `wedge:rounds:${await run(w, 'completed')}`,
    },
    {
      kind: 'capacity',
      live: async (w) => {
        await job(w, 'queued', 'drive');
        return `wedge:capacity:${w.projectId}:drive`;
      },
      over: async (w) => {
        await job(w, 'running', 'drive');
        return `wedge:capacity:${w.projectId}:all`;
      },
    },
  ];

  for (const c of cases) {
    it(`a ${c.kind} wedge`, async () => {
      const w = await world();
      const live = await wedgeHolding(w, await c.live(w));
      await reevaluate(new Date());
      expect(await stateOf(live.wedgeId), 'while its subject stands').toEqual({
        state: 'firing',
        resolved: false,
      });
      expect((await stateOf(live.heldId)).state).toBe('inhibited');

      await truncateAll(harness.db);
      const w2 = await world();
      const over = await wedgeHolding(w2, await c.over(w2));
      await reevaluate(new Date());
      expect((await stateOf(over.wedgeId)).resolved, 'once its subject is over').toBe(true);
      expect((await stateOf(over.heldId)).state).toBe('pending');
    });
  }

  it('ends a wedge keyed on a shape no resolver reads, rather than holding its project for ever', async () => {
    const w = await world();
    const { wedgeId, heldId } = await wedgeHolding(w, 'wedge:something-else');

    await reevaluate(new Date());

    expect((await stateOf(wedgeId)).resolved).toBe(true);
    expect((await stateOf(heldId)).state).toBe('pending');
  });
});

describe('where a wedge is raised', () => {
  it('refuses a key no resolver could end, writing nothing', async () => {
    const w = await world();
    // A run is keyed by what about it is wedged (`paused:` or `rounds:`); a bare run id names neither.
    await emitPipelineWedge({
      projectId: w.projectId,
      hop: 'dispatch',
      entity: 'run',
      entityId: await run(w, 'running'),
      reason: 'planted',
      action: 'planted',
    });
    const [row] = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM notifications WHERE type = 'pipeline_wedge'
    `)) as unknown as Array<{ n: number }>;
    expect(row?.n).toBe(0);
  });

  it('raises a session-keyed wedge whose key its resolver reads', async () => {
    const w = await world();
    const sessionId = await session(w, 'running');
    await emitPipelineWedge({
      projectId: w.projectId,
      hop: 'claim',
      entity: 'session',
      entityId: sessionId,
      reason: 'planted',
      action: 'planted',
    });
    const [row] = (await harness.db.execute(sql`
      SELECT resolution_key AS key FROM notifications WHERE type = 'pipeline_wedge'
    `)) as unknown as Array<{ key: string }>;
    expect(row?.key).toBe(`wedge:${sessionId}`);
  });
});

describe('two reasons held for one issue behind one wedge (judge-41, criterion 94)', () => {
  it('releases only the more specific one, and retires the other rather than telling both', async () => {
    const w = await world();
    const sessionId = await session(w, 'failed');
    const { wedgeId, heldId: owedId } = await wedgeHolding(w, `wedge:${sessionId}`);
    await harness.db.execute(sql`
      UPDATE notifications SET resolution_key = ${`issue:${w.issueId}:owed-close`} WHERE id = ${owedId}::uuid
    `);
    const [idle] = (await harness.db.execute(sql`
      INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key,
                                 inhibited_by, pending_since, last_seen_at)
      VALUES (${w.projectId}::uuid, ${w.issueId}::uuid, 'issue_stranded', 'condition', 'ticket',
              'inhibited', 'held', ${`issue:${w.issueId}:idle`}, ${wedgeId}::uuid, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    await reevaluate(new Date());

    expect(await stateOf(owedId)).toEqual({ state: 'pending', resolved: false });
    expect((await stateOf(idle?.id ?? '')).resolved).toBe(true);
  });
});
