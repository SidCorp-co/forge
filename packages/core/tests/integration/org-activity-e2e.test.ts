/**
 * ISS-951 (MK-8): `GET /api/orgs/:orgId/activity` answers one row per project of the workspace the
 * caller can read: what is in flight at its recorded step, what its master takes next in the master's
 * own admissible order, what waits on people and on a release. A project the caller cannot read is
 * absent, not blanked; an archived one is absent; an org with no project answers empty rows and zero
 * totals; a caller outside the org is refused.
 *
 * @direct-test-of packages/core/src/activity/read.ts
 * @direct-test-of packages/core/src/activity/routes.ts
 * @direct-test-of packages/core/src/activity/index.ts
 * @direct-test-of packages/core/src/devices/admissible.ts
 * @direct-test-of packages/core/src/development/needs-you-viewer.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  seedOrg,
} from '../helpers/factories.js';

let orgId = '';
let emptyOrg = '';
let readable = '';
let hidden = '';
let archived = '';
const tokens: Record<'owner' | 'member' | 'outsider' | 'emptyOwner', string> = {
  owner: '',
  member: '',
  outsider: '',
  emptyOwner: '',
};
const ids: Record<string, string> = {};

async function orgMember(org: string, userId: string, role: 'owner' | 'admin' | 'member') {
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${org}, ${userId}, ${role})`);
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const owner = await createTestUser({ verified: true });
  const member = await createTestUser({ verified: true });
  const outsider = await createTestUser({ verified: true });
  const emptyOwner = await createTestUser({ verified: true });
  orgId = await seedOrg(owner.id);
  await orgMember(orgId, member.id, 'member');
  emptyOrg = await seedOrg(emptyOwner.id);

  readable = (await createTestProject(owner.id, { orgId })).id;
  hidden = (await createTestProject(owner.id, { orgId })).id;
  archived = (await createTestProject(owner.id, { orgId })).id;
  await db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${archived}`);
  await addProjectMember(readable, member.id, 'member');
  await addProjectMember(archived, member.id, 'member');

  const at = new Date(Date.now() - 3_600_000);
  ids.building = (
    await createTestIssue(readable, owner.id, 1, { status: 'in_progress', createdAt: at })
  ).id;
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
    VALUES (${ids.building}, 'build', now() - interval '20 minutes', now())`);
  ids.low = (
    await createTestIssue(readable, owner.id, 2, { status: 'open', createdAt: at, priority: 'low' })
  ).id;
  ids.high = (
    await createTestIssue(readable, owner.id, 3, {
      status: 'open',
      createdAt: at,
      priority: 'high',
    })
  ).id;
  ids.medium = (
    await createTestIssue(readable, owner.id, 4, {
      status: 'open',
      createdAt: at,
      priority: 'medium',
    })
  ).id;
  ids.landed = (
    await createTestIssue(readable, owner.id, 5, {
      status: 'awaiting_release',
      createdAt: at,
      mergedAt: at,
    })
  ).id;
  ids.secret = (
    await createTestIssue(hidden, owner.id, 1, { status: 'in_progress', createdAt: at })
  ).id;

  tokens.owner = await userToken(owner.id);
  tokens.member = await userToken(member.id);
  tokens.outsider = await userToken(outsider.id);
  tokens.emptyOwner = await userToken(emptyOwner.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const activity = async (who: keyof typeof tokens, org = orgId) => {
  const res = await api(tokens[who], 'GET', `/api/orgs/${org}/activity`);
  return { status: res.status, body: res.body as Doc };
};

describe('ISS-951 GET /api/orgs/:orgId/activity', () => {
  it('a member reads only the projects they can read: the hidden and the archived project are absent', async () => {
    const res = await activity('member');
    expect(res.status).toBe(200);
    const listed = (res.body.projects as Doc[]).map((p) => p.projectId);
    expect(listed).toEqual([readable]);
    expect(JSON.stringify(res.body), 'a hidden project leaked into the read').not.toContain(hidden);
    expect(res.body.totals.projects).toBe(1);
  });

  it('the org owner reads every live project of the org', async () => {
    const res = await activity('owner');
    expect(res.status).toBe(200);
    expect((res.body.projects as Doc[]).map((p) => p.projectId).sort()).toEqual(
      [readable, hidden].sort(),
    );
  });

  it('now carries the in-flight issue at its recorded step; next is the master admissible order', async () => {
    const { readAdmissibleForProjects } = await import('../../src/devices/index.js');
    const res = await activity('member');
    const row = (res.body.projects as Doc[])[0] as Doc;
    expect(row.now.map((n: Doc) => [n.issueId, n.step])).toEqual([[ids.building, 'build']]);
    expect(row.now[0].stepSince).toEqual(expect.any(String));
    const master = await readAdmissibleForProjects([readable], 5);
    expect(
      row.next.items.map((n: Doc) => n.issueId),
      'the page re-derived the order',
    ).toEqual(master.items.map((a) => a.issueId));
    expect(row.next.items.map((n: Doc) => n.issueId)).toEqual([ids.high, ids.medium, ids.low]);
    expect(row.next.total).toBe(3);
    expect(row.awaitingRelease).toBe(1);
    expect(row.master.state).toBe('none');
    expect(row.group, 'an issue in flight is working, whatever the master').toBe('working');
    expect(res.body.totals).toMatchObject({
      inFlight: 1,
      queued: 3,
      awaitingRelease: 1,
      noMaster: 1,
    });
  });

  it('next counts every admissible issue while it names only the first few', async () => {
    const { readAdmissibleForProjects } = await import('../../src/devices/index.js');
    const capped = await readAdmissibleForProjects([readable], 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.totals.get(readable)).toBe(3);
  });

  it('an org with no project answers no rows and zero totals', async () => {
    const res = await activity('emptyOwner', emptyOrg);
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
    expect(res.body.totals).toEqual({
      projects: 0,
      inFlight: 0,
      queued: 0,
      people: 0,
      awaitingRelease: 0,
      noMaster: 0,
    });
  });

  it('a caller outside the org is refused', async () => {
    const res = await activity('outsider');
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(res.body)).not.toContain(readable);
  });

  it('a path naming no org uuid is refused by name', async () => {
    const res = await api(tokens.owner, 'GET', `/api/orgs/not-a-uuid/activity`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('/api/orgs/<org uuid>/activity');
  });

  it('a stale claim step reads as the step core recorded after it', async () => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${readable}, 6, 'claimed then planned', 'in_progress', (SELECT created_by FROM projects WHERE id = ${readable}))`);
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at, updated_at)
      VALUES (${id}, 'triage', now() - interval '105 minutes', now())`);
    const planned = await api(tokens.owner, 'PATCH', `/api/issues/${id}`, { plan: 'the plan' });
    expect(planned.status).toBe(200);
    const row = ((await activity('member')).body.projects as Doc[])[0] as Doc;
    const item = row.now.find((n: Doc) => n.issueId === id);
    expect(item?.step, 'the read kept the claim step after a plan was written').toBe('plan');
  });
});
