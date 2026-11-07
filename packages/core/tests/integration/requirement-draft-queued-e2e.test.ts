/**
 * A draft an agent wrote waits on its master to propose or drop it, and that wait is a queue, not a
 * fault (ISS-1072 round 2). On forge-dev, 2026-11-07, Requirements read "Stuck 15", two of them
 * drafts a day old waiting on "Master · propose or drop r1": the act read the master's one-working-day
 * take clock. Round 1 gave the issue's queue acts no clock (`lib/standing-act-class.ts`, the `queue`
 * class); the requirement's propose-or-drop is one of them, so a served project's agent draft stays in
 * Waiting however long it has sat, while one nobody serves still reads stuck by who serves it.
 *
 * @direct-test-of packages/core/src/lib/standing-act-class.ts
 * @direct-test-of packages/core/src/requirements/standing-draft.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

let projectId = '';
let ownerId = '';
let token = '';
let box = '';
const WEEK_AGO = new Date(Date.now() - 8 * 86_400_000).toISOString();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  // a bound runner makes the project's master the one who acts on an agent's draft, not a person
  box = await createTestDevice(ownerId);
  await bindTestRunner(projectId, box);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** A draft requirement whose r1 an agent wrote eight days ago, never proposed. */
async function agentDraft(title: string): Promise<string> {
  const res = await api(token, 'POST', `/api/projects/${projectId}/requirements`, {
    title,
    reason: 'the rule it states',
    criteria: [{ body: 'it holds' }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const key = String(res.body.key);
  await db.execute(sql`
    UPDATE requirement_revisions SET author_agency = 'agent', created_at = ${WEEK_AGO}
     WHERE requirement_id = (SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))})`);
  await db.execute(sql`
    UPDATE requirements SET created_at = ${WEEK_AGO}, updated_at = ${WEEK_AGO}
     WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`);
  return key;
}

/** A live master session serving the project, as `forecast-world.ts:servingMaster` seats one. */
async function seatMaster(): Promise<void> {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'interactive', 'running')`);
  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, device_id, last_heartbeat_at)
    VALUES (${randomUUID()}, ${projectId}, ${ownerId}, ${runId}, 'master', 'running', ${box}, now())`);
}

async function rowOf(key: string): Promise<Doc> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/requirements`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const list = (res.body.requirements ?? res.body.items) as Doc[];
  const row = list.find((r) => r.key === key);
  expect(row, JSON.stringify(list.map((r) => r.key))).toBeDefined();
  return (row as Doc).standing as Doc;
}

describe("an agent's draft waiting on its master's propose-or-drop (ISS-1072)", () => {
  it('reads stuck while no master serves the project, by who serves it', async () => {
    const key = await agentDraft('A draft nobody serves');
    const row = await rowOf(key);
    expect(row.attentionGroup, JSON.stringify(row.waitingOn)).toBe('stuck');
    expect((row.times as Doc).stuck).toMatchObject({ code: 'nobody_serves' });
  });

  it('is queued, never stuck, a week on, where a master serves it', async () => {
    await seatMaster();
    const key = await agentDraft('A draft the master will propose');
    const row = await rowOf(key);
    expect((row.waitingOn as Doc).says).toMatchObject({
      act: { key: 'standing.act.proposeOrDrop' },
    });
    expect(row.attentionGroup).toBe('waiting');
    expect((row.times as Doc).actClass).toBe('queue');
    expect((row.times as Doc).stuck).toBeNull();
    expect((row.times as Doc).dueAt).toBeNull();
  });
});
