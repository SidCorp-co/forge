/**
 * ISS-1245: a run is opened only while its project has a free subagent slot on the box, by the one
 * rule (`devices/run-slots.ts:slotsFor`) over what the box holds now. A live slot is an open run
 * session, so `run declare` claims one (its preflight and its open) and the run's close gives it back.
 *
 * @direct-test-of packages/core/src/devices/run-slots-read.ts
 * @direct-test-of packages/core/src/devices/run-slot-wait.ts
 * @direct-test-of packages/core/src/devices/run-session.ts
 * @direct-test-of packages/core/src/devices/run-session-routes.ts
 * @direct-test-of packages/core/src/steward/dispatch.ts
 * @direct-test-of packages/core/src/masters/service.ts
 * @direct-test-of packages/core/src/masters/read.ts
 * @direct-test-of packages/core/src/issues/issue-lease.ts
 * @direct-test-of packages/core/src/devices/run-issue-return.ts
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
let c = '';
let waitBox = '';

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
  // ISS-1266's box: one slot, one project, three issues of which the third is held by a blocks edge
  c = (await createTestProject(ownerId)).id;
  waitBox = await createTestDevice(ownerId, { maxSubagents: null });
  await bindTestRunner(c, waitBox);
  for (const seq of [1, 2, 3]) await issue(c, seq);
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    SELECT ${c}, blocker.id, held.id, 'blocks'
      FROM issues held, issues blocker
     WHERE held.project_id = ${c} AND held.iss_seq = 3
       AND blocker.project_id = ${c} AND blocker.iss_seq = 2`);
  const mint = async (deviceId: string, name: string) =>
    (await mintPat({ permissions: ['*'], userId: ownerId, name, deviceId, projectIds: [a, b, c] }))
      .plaintext;
  say = requester(app, {
    box: await mint(boxId, 'box'),
    lone: await mint(lone, 'lone'),
    waitBox: await mint(waitBox, 'waitBox'),
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

const close = (sessionId: string, who = 'box') =>
  say(who, 'POST', `/api/devices/me/run-sessions/${sessionId}/close`, { outcome: 'ended' });

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

  // ISS-1260: the steward's tick took the slot a queued declaration waited for, every time it freed
  it('refuses work core starts on its own while a declaration waits for the slot, until the box stops re-sending it', async () => {
    const { refuseRunWithoutSlot } = await import('../../src/devices/run-slots-read.js');
    const refusal = async (yieldToQueued: boolean): Promise<string> => {
      try {
        await refuseRunWithoutSlot({ deviceId: boxId, projectId: a, yieldToQueued });
        return 'admitted';
      } catch (err) {
        return String((err as Error).message ?? err);
      }
    };
    expect(await refusal(true)).toContain('has a run declaration queued for a slot on this box');
    // the declaration's own re-send and a master's declare ask without yielding, and read the count
    expect(await refusal(false)).not.toContain('queued for a slot');
    // a declaration the box stopped re-sending is the reaper's, and holds the slot for nobody
    await db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '1 day'
       WHERE project_id = ${a} AND device_id = ${boxId} AND status = 'queued'`);
    expect(await refusal(true)).not.toContain('queued for a slot');
    await db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now()
       WHERE project_id = ${a} AND device_id = ${boxId} AND status = 'queued'`);
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

  // a master building one issue in parts holds it through each part's run, each in a tree of its
  // own and each taking a slot; another master is refused it by name, while any part still runs
  it('opens two runs of one master over one issue, each a slot, and refuses another master', async () => {
    await issue(a, 6);
    const registered = async (who: string, name: string, size: number) =>
      (
        await say(who, 'POST', '/api/devices/me/master-session', {
          projectId: a,
          name,
          maxJobPanes: 2,
          maxSubagents: size,
        })
      ).status;
    expect(await registered('box', `master-${a.slice(0, 4)}`, 4)).toBe(200);
    expect(await registered('lone', 'lone-master', 2)).toBe(200);
    const parts = [await open('box', a, 'ISS-6'), await open('box', a, 'ISS-6')];
    for (const p of parts) expect(p.status, detail(p)).toBe(200);
    const [first, second] = parts.map((p) => (p.json as Doc).sessionId as string);
    const live = (await db.execute(sql`
      SELECT count(*)::int AS n FROM agent_sessions
       WHERE device_id = ${boxId} AND project_id = ${a} AND kind = 'run_session'
         AND status IN ('running', 'idle')`)) as unknown as Array<{ n: number }>;
    expect(live[0]?.n).toBe(2);
    const other = await open('lone', a, 'ISS-6');
    expect(codes(other)).toEqual(['ISSUE_LEASE_HELD']);
    // the first part ends: the lease passes to the part still building, and still refuses the other
    expect((await close(first as string)).status).toBe(200);
    const [lease] = (await db.execute(sql`
      SELECT session_id::text AS session_id FROM issue_leases
       WHERE project_id = ${a} AND issue_key = 'ISS-6'`)) as unknown as Array<{
      session_id: string;
    }>;
    expect(lease?.session_id).toBe(second);
    expect(codes(await open('lone', a, 'ISS-6'))).toEqual(['ISSUE_LEASE_HELD']);
  });

  // ISS-1266: since the declare's preflight asks for a slot first, a refused declare writes no queued
  // row, so the steward had nothing to yield to and took every slot that freed
  it("keeps a master's declare refused for a slot as a wait the steward yields to, until it opens or lapses", async () => {
    const { refuseRunWithoutSlot } = await import('../../src/devices/run-slots-read.js');
    const steward = async (yieldToQueued = true): Promise<string> => {
      try {
        await refuseRunWithoutSlot({ deviceId: waitBox, projectId: c, yieldToQueued });
        return 'admitted';
      } catch (err) {
        return String((err as Error).message ?? err);
      }
    };
    const wait = async () => {
      const [row] = (await db.execute(sql`
        SELECT metadata -> 'slotWait' AS wait FROM agent_sessions
         WHERE device_id = ${waitBox} AND project_id = ${c} AND kind = 'master'`)) as unknown as Array<{
        wait: Doc | null;
      }>;
      return row?.wait ?? null;
    };
    const registered = await say('waitBox', 'POST', '/api/devices/me/master-session', {
      projectId: c,
      name: 'wait-master',
      maxJobPanes: 1,
      maxSubagents: 1,
    });
    expect(registered.status).toBe(200);
    const first = await open('waitBox', c, 'ISS-1');
    expect(first.status, detail(first)).toBe(200);
    // a hold that is not a slot refuses first, by its own name, and leaves no wait
    const blocked = await preflight('waitBox', c, 'ISS-3');
    expect(codes(blocked)).toContain('ISSUE_BLOCKED');
    expect(await wait()).toBeNull();
    // refused only for a slot: the same answer by name, no queued row, and the master's wait kept
    const refused = await preflight('waitBox', c, 'ISS-2');
    expect(codes(refused)).toEqual(['RUN_SLOT_UNAVAILABLE']);
    expect(detail(refused)).toContain('holds 1 subagent slot(s) on this box and 1 are in use');
    const queued = (await db.execute(sql`
      SELECT count(*)::int AS n FROM agent_sessions
       WHERE device_id = ${waitBox} AND status = 'queued'`)) as unknown as Array<{ n: number }>;
    expect(queued[0]?.n).toBe(0);
    expect((await wait())?.issueKeys).toEqual(['ISS-2']);
    // the slot frees: work core starts on its own yields it to the master's next declare
    expect((await close((first.json as Doc).sessionId as string, 'waitBox')).status).toBe(200);
    expect(await steward()).toContain('a master refused a slot on this box');
    expect(await steward(false)).toBe('admitted');
    // a wait its master stopped renewing holds the slot for nobody
    await db.execute(sql`
      UPDATE agent_sessions
         SET metadata = jsonb_set(metadata, '{slotWait,at}', to_jsonb((now() - interval '11 minutes')::text))
       WHERE device_id = ${waitBox} AND project_id = ${c} AND kind = 'master'`);
    expect(await steward()).toBe('admitted');
    // renewed, it holds again, and the master's own open takes the slot and ends it
    await db.execute(sql`
      UPDATE agent_sessions SET metadata = jsonb_set(metadata, '{slotWait,at}', to_jsonb(now()::text))
       WHERE device_id = ${waitBox} AND project_id = ${c} AND kind = 'master'`);
    expect(await steward()).toContain('a master refused a slot on this box');
    const second = await open('waitBox', c, 'ISS-2');
    expect(second.status, detail(second)).toBe(200);
    expect(await wait()).toBeNull();
    expect((await close((second.json as Doc).sessionId as string, 'waitBox')).status).toBe(200);
    expect(await steward()).toBe('admitted');
  });
});
