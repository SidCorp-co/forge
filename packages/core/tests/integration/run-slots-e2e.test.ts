/**
 * ISS-1245: a run is opened only while its project has a free subagent slot on the box, by the one
 * rule (`devices/run-slots.ts:slotsFor`) over what the box holds now. A live slot is an open run
 * session, so `run declare` claims one (its preflight and its open) and the run's close gives it back.
 *
 * @direct-test-of packages/core/src/devices/run-slots-read.ts
 * @direct-test-of packages/core/src/devices/run-session.ts
 * @direct-test-of packages/core/src/devices/run-session-routes.ts
 * @direct-test-of packages/core/src/masters/service.ts
 * @direct-test-of packages/core/src/masters/read.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

type Say = (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
let say: Say;
let ownerId = '';
let a = '';
let b = '';
let boxId = '';

async function issue(projectId: string, seq: number, priority = 'medium'): Promise<void> {
  await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${priority}, ${ownerId})
  `);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  ownerId = (await createTestUser({ verified: true })).id;
  a = (await createTestProject(ownerId)).id;
  b = (await createTestProject(ownerId)).id;
  // undeclared until the master below registers, as a box whose runner is from before ISS-1245
  boxId = await createTestDevice(ownerId, { maxSubagents: null });
  const lone = await createTestDevice(ownerId, { maxSubagents: null });
  for (const p of [a, b]) await bindTestRunner(p, boxId);
  await bindTestRunner(a, lone);
  for (const seq of [1, 2, 3, 4, 5]) await issue(a, seq, seq === 5 ? 'critical' : 'medium');
  const mint = async (deviceId: string, name: string) =>
    (await mintPat({ permissions: ['*'], userId: ownerId, name, deviceId, projectIds: [a, b] }))
      .plaintext;
  say = requester(app, {
    box: await mint(boxId, 'box'),
    lone: await mint(lone, 'lone'),
    person: await userToken(ownerId),
  }) as Say;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const codes = (r: Reply): string[] =>
  ((r.json as Doc).error?.refusals ?? []).map((x: Doc) => x.code);
const detail = (r: Reply): string => JSON.stringify(r.json);

const preflight = (who: string, projectId: string, key: string) =>
  say(who, 'POST', '/api/devices/me/run-sessions/preflight', { projectId, issueKeys: [key] });

async function open(who: string, projectId: string, key: string): Promise<Reply> {
  return say(who, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId: crypto.randomUUID(),
    issueKeys: [key],
    name: key,
  });
}

const close = (sessionId: string) =>
  say('box', 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

const sessions: Record<string, string> = {};

describe('subagent slots at run declare', () => {
  it('stores the box size its runner declares beside its job panes', async () => {
    for (const p of [a, b]) {
      const r = await say('box', 'POST', '/api/devices/me/master-session', {
        projectId: p,
        name: `master-${p.slice(0, 4)}`,
        maxJobPanes: 2,
        maxSubagents: 2,
      });
      expect(r.status).toBe(200);
    }
    const [row] = (await db.execute(
      sql`SELECT max_subagents FROM devices WHERE id = ${boxId}`,
    )) as unknown as Array<{ max_subagents: number | null }>;
    expect(row?.max_subagents).toBe(2);
  });

  it('lends a busy project the slot an idle one leaves, and refuses the one past the box', async () => {
    // b has no work yet, so a may use the whole box
    for (const key of ['ISS-1', 'ISS-2']) {
      const r = await open('box', a, key);
      expect(r.status, detail(r)).toBe(200);
      sessions[key] = (r.json as Doc).sessionId;
    }
    const refused = await preflight('box', a, 'ISS-3');
    expect(refused.status).toBe(422);
    expect(codes(refused)).toEqual(['RUN_SLOT_UNAVAILABLE']);
    expect(detail(refused)).toContain('holds 2 subagent slot(s) on this box and 2 are in use');
    expect(detail(refused)).toContain('One frees when a run of this project closes');
  });

  it('queues an open refused for a slot behind slot_full, holding none', async () => {
    const runId = crypto.randomUUID();
    const r = await say('box', 'POST', '/api/devices/me/run-sessions', {
      projectId: a,
      runId,
      issueKeys: ['ISS-3'],
      name: 'ISS-3',
    });
    expect(codes(r)).toEqual(['RUN_SLOT_UNAVAILABLE']);
    const rows = (await db.execute(sql`
      SELECT s.status, pr.metadata -> 'declarationRefusal' ->> 'gate' AS gate
        FROM agent_sessions s JOIN pipeline_runs pr ON pr.id = s.pipeline_run_id
       WHERE pr.metadata ->> 'boxRunId' = ${runId}`)) as unknown as Array<{
      status: string;
      gate: string;
    }>;
    expect(rows).toEqual([{ status: 'queued', gate: 'slot_full' }]);
    // the queued row holds no slot: the count is still two
    expect(detail(await preflight('box', a, 'ISS-3'))).toContain('2 are in use');
  });

  it('gives a project that gets work its floor at once, past the box, stopping nothing', async () => {
    await issue(b, 1);
    const r = await open('box', b, 'ISS-1');
    expect(r.status, detail(r)).toBe(200);
    sessions.b = (r.json as Doc).sessionId;
    const live = (await db.execute(sql`
      SELECT count(*)::int AS n FROM agent_sessions
       WHERE device_id = ${boxId} AND kind = 'run_session'
         AND status IN ('running', 'idle')`)) as unknown as Array<{
      n: number;
    }>;
    expect(live[0]?.n).toBe(3);
  });

  it('holds the project over its share to it as its runs end, and frees one when it is under', async () => {
    expect(codes(await preflight('box', a, 'ISS-3'))).toEqual(['RUN_SLOT_UNAVAILABLE']);
    expect((await close(sessions['ISS-1'] as string)).status).toBe(200);
    // a now holds 1 slot beside b's floor, and uses 1: still none free
    const still = await preflight('box', a, 'ISS-3');
    expect(detail(still)).toContain('holds 1 subagent slot(s) on this box and 1 are in use');
    expect((await close(sessions['ISS-2'] as string)).status).toBe(200);
    expect((await preflight('box', a, 'ISS-3')).status).toBe(200);
  });

  it('serves the slots, the runs and the waiting work on the master standing', async () => {
    const r = await say('person', 'GET', `/api/projects/${a}/masters/standing`);
    expect(r.status).toBe(200);
    const sub = (r.json as Doc).slots.subagents;
    expect(sub.capacity).toBe(2);
    expect(sub.inUse).toBe(0);
    expect(sub.held).toBeGreaterThanOrEqual(1);
    expect(sub.waiting).toBeGreaterThanOrEqual(1);
  });

  it('holds an undeclared box to the floor of 1 per project, and says how to declare it', async () => {
    const first = await open('lone', a, 'ISS-4');
    expect(first.status, detail(first)).toBe(200);
    const second = await preflight('lone', a, 'ISS-5');
    expect(codes(second)).toEqual(['RUN_SLOT_UNAVAILABLE']);
    expect(detail(second)).toContain('declares no `max_subagents`');
  });
});
