/**
 * A run a master declared holds its issue through the lease on the issue's work state, and that run
 * makes the moves the issue machine gives "the run holding the issue". Planted from adminhub-api
 * ISS-8 on dev, 2026-10-23: the master claimed ISS-8 as `adminhub-j5011-20261023` from its box, the
 * run moved it reopen → in_progress under that lease, and its move to awaiting_release was refused
 * NOT_THE_HOLDER, "no run session holds it while the caller is device c04dcd83", because that guard
 * read only the fleet leases run sessions take. The orchestrator moved it by hand.
 *
 * The box's credential here is an agent account with the member role, as the box's is: it holds
 * neither `releases.approve` nor `project.admin`, so only being the holder lets it through.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';

const HOLDER = 'adminhub-j5011-20261023';
const SHA = 'ad'.repeat(20);
const LIFECYCLE = { 'X-Forge-Lifecycle': '10' };

const world = {
  projectId: '',
  ownerId: '',
  owner: '',
  box: '',
  boxPat: '',
  otherBox: '',
  otherPat: '',
};

async function boxPat(userId: string, deviceId: string, ownerId: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  return (
    await mintPat({
      permissions: ['*'],
      userId,
      name: `workspace:${deviceId}:${world.projectId}`,
      deviceId,
      projectIds: [world.projectId],
      onBehalfOf: ownerId,
    })
  ).plaintext;
}

async function seedWorld(): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.owner = await userToken(world.ownerId);
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(world.projectId, agent, 'member');
  world.box = await createTestDevice(world.ownerId);
  world.otherBox = await createTestDevice(world.ownerId);
  world.boxPat = await boxPat(agent, world.box, world.ownerId);
  world.otherPat = await boxPat(agent, world.otherBox, world.ownerId);
}

const call = (token: string, method: 'POST' | 'PATCH', path: string, body: unknown) =>
  api(token, method, path, body, LIFECYCLE);

const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** The master's claim from its box: the lease the run then works under, read back as sent. */
async function declare(issueId: string, token: string, minutes = 60): Promise<void> {
  const lease = { holder: HOLDER, renewedAt: new Date().toISOString(), minutes };
  const res = await call(token, 'PATCH', `/api/issues/${issueId}`, { sessionContext: { lease } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const [read] = [
    ...(await db.execute(
      sql`SELECT issue_session_context(id, session_context) AS sc FROM issues WHERE id = ${issueId}`,
    )),
  ] as unknown as Array<{ sc: unknown }>;
  expect(read?.sc).toEqual({ lease });
}

const move = (issueId: string, token: string, toStatus: string) =>
  call(token, 'POST', `/api/issues/${issueId}/transition`, {
    toStatus,
    reason: 'every criterion passes at the head the run judged',
  });

async function iss8(): Promise<string> {
  const { id } = await createTestIssue(world.projectId, world.ownerId, 8, {
    status: 'reopen',
    createdAt: new Date(),
  });
  return id;
}

async function merged(issueId: string): Promise<void> {
  await db.execute(
    sql`UPDATE issues SET merged_at = now(), merged_commit_sha = ${SHA} WHERE id = ${issueId}`,
  );
}

async function statusOf(issueId: string): Promise<string | undefined> {
  const [row] = [
    ...(await db.execute(sql`SELECT status FROM issues WHERE id = ${issueId}`)),
  ] as unknown as Array<{ status: string }>;
  return row?.status;
}

describe('a declared run is the run holding its issue', () => {
  beforeEach(seedWorld);

  it('moves ISS-8 reopen → in_progress → awaiting_release from the box that declared it', async () => {
    const id = await iss8();
    await declare(id, world.boxPat);
    const taken = await move(id, world.boxPat, 'in_progress');
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    await merged(id);
    const released = await move(id, world.boxPat, 'awaiting_release');
    expect([released.status, codeOf(released.body)], JSON.stringify(released.body)).toEqual([
      200,
      null,
    ]);
    expect(await statusOf(id)).toBe('awaiting_release');
  });

  it('stays the holder when a person rewrites the lease it declared', async () => {
    const id = await iss8();
    await declare(id, world.boxPat);
    expect((await move(id, world.boxPat, 'in_progress')).status).toBe(200);
    await declare(id, world.owner, 30);
    await merged(id);
    const released = await move(id, world.boxPat, 'awaiting_release');
    expect([released.status, codeOf(released.body)], JSON.stringify(released.body)).toEqual([
      200,
      null,
    ]);
  });

  it('refuses another box by name, naming the declared run and the box it was declared from', async () => {
    const id = await iss8();
    await declare(id, world.boxPat);
    expect((await move(id, world.boxPat, 'in_progress')).status).toBe(200);
    await merged(id);
    const refused = await move(id, world.otherPat, 'awaiting_release');
    expect([refused.status, codeOf(refused.body)]).toEqual([403, 'NOT_THE_HOLDER']);
    const text = JSON.stringify(refused.body);
    expect(text).toContain(HOLDER);
    expect(text).toContain(world.box);
    expect(text).toContain(world.otherBox);
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('refuses the declaring box once its lease has lapsed', async () => {
    const id = await iss8();
    await declare(id, world.boxPat);
    expect((await move(id, world.boxPat, 'in_progress')).status).toBe(200);
    await merged(id);
    await db.execute(sql`
      UPDATE issue_work_state
         SET lease = jsonb_set(lease, '{renewedAt}', to_jsonb((now() - interval '2 hours')::text))
       WHERE issue_id = ${id}`);
    const refused = await move(id, world.boxPat, 'awaiting_release');
    expect([refused.status, codeOf(refused.body)]).toEqual([403, 'NOT_THE_HOLDER']);
  });

  it('refuses a run whose run session has ended, though its fleet lease row is still there', async () => {
    const id = await iss8();
    const sessionId = randomUUID();
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${world.projectId}, 'system', 'completed', '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status)
      VALUES (${sessionId}, ${world.projectId}, ${world.box}, ${runId}, 'run_session', 'completed')`);
    await db.execute(sql`
      INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
      VALUES (${world.projectId}, 'ISS-8', ${world.box}, ${sessionId}, ${runId})`);
    await seedIssueStatus(id, 'in_progress');
    await merged(id);
    const refused = await move(id, world.boxPat, 'awaiting_release');
    expect([refused.status, codeOf(refused.body)]).toEqual([403, 'NOT_THE_HOLDER']);
  });
});
