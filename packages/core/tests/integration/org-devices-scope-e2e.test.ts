/**
 * The organisation's devices are a different population from the caller's own,
 * and the route that serves them says which is which (ISS-1162).
 *
 * Measured on forge-beta 2026-09-21: `/runners` reported "No devices yet" to an
 * admin while the same account's Overview reported 40 runners, because the only
 * device list in the app filtered on `devices.owner_id` and its `orgId`
 * parameter narrowed that personal list instead of widening it.
 *
 * Against real Postgres, because every claim here is about which rows a join and
 * a visibility predicate return — a mocked row set answers whatever the test
 * feeds it and could not go red on a wrong `WHERE`.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

interface Fixture {
  callerToken: string;
  callerId: string;
  outsiderToken: string;
  orgId: string;
  otherOrgId: string;
  myDeviceId: string;
  otherMemberDeviceId: string;
  hiddenDeviceId: string;
  unboundDeviceId: string;
  visibleProjectNames: string[];
}

async function addRunner(
  db: TestDatabase['db'],
  args: { projectId: string; deviceId: string; name: string },
) {
  await db.execute(sql`
    INSERT INTO runners (project_id, type, device_id, name, status)
    VALUES (${args.projectId}, 'claude-code', ${args.deviceId}, ${args.name}, 'online')
  `);
}

/**
 * The caller is an ordinary org MEMBER, not an owner: `visibleProjectsWhere`
 * hands an owner or admin every project in the org, so only a plain member can
 * have a project in their own org they cannot see — which is the case that
 * separates "the organisation's devices" from "the devices this reader is
 * entitled to know about".
 */
async function seed(): Promise<Fixture> {
  const db = harness.db;
  const caller = await createTestUser(db, { emailVerifiedAt: new Date() });
  const otherMember = await createTestUser(db, { emailVerifiedAt: new Date() });
  const outsider = await createTestUser(db, { emailVerifiedAt: new Date() });

  const org = await seedOrg(db, otherMember.id);
  await createTestOrgMember(db, { orgId: org.id, userId: caller.id, role: 'member' });
  const otherOrg = await seedOrg(db, outsider.id);

  const visibleA = await createTestProject(db, otherMember.id, {
    orgId: org.id,
    name: 'Pipeline Alpha',
  });
  const visibleB = await createTestProject(db, otherMember.id, {
    orgId: org.id,
    name: 'Pipeline Beta',
  });
  const hidden = await createTestProject(db, otherMember.id, {
    orgId: org.id,
    name: 'Pipeline Hidden',
  });
  await createTestProjectMember(db, { userId: caller.id, projectId: visibleA.id });
  await createTestProjectMember(db, { userId: caller.id, projectId: visibleB.id });

  const myDevice = await createTestDevice(db, caller.id, { name: 'my-laptop' });
  const otherMemberDevice = await createTestDevice(db, otherMember.id, { name: 'sid-xeon-1' });
  const hiddenDevice = await createTestDevice(db, otherMember.id, { name: 'hidden-box' });
  const unboundDevice = await createTestDevice(db, caller.id, { name: 'just-paired' });

  await addRunner(db, { projectId: visibleA.id, deviceId: myDevice.id, name: 'mine-a' });
  await addRunner(db, { projectId: visibleA.id, deviceId: otherMemberDevice.id, name: 'theirs-a' });
  await addRunner(db, { projectId: visibleB.id, deviceId: otherMemberDevice.id, name: 'theirs-b' });
  await addRunner(db, { projectId: hidden.id, deviceId: hiddenDevice.id, name: 'hidden-a' });

  return {
    callerToken: await signUserToken(caller.id),
    callerId: caller.id,
    outsiderToken: await signUserToken(outsider.id),
    orgId: org.id,
    otherOrgId: otherOrg.id,
    myDeviceId: myDevice.id,
    otherMemberDeviceId: otherMemberDevice.id,
    hiddenDeviceId: hiddenDevice.id,
    unboundDeviceId: unboundDevice.id,
    visibleProjectNames: ['Pipeline Alpha', 'Pipeline Beta'],
  };
}

interface OrgDeviceBody {
  id: string;
  name: string;
  ownedByMe: boolean;
  runnerCount: number;
  projectNames: string[];
}

function get(path: string, token: string) {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.NODE_ENV ??= 'test';

  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  const { orgRoutes } = await import('../../src/orgs/routes.js');
  const { deviceOwnerRoutes } = await import('../../src/devices/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/orgs', orgRoutes);
  app.route('/api', deviceOwnerRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('GET /api/orgs/:orgId/devices', () => {
  it('lists a device another member paired, which the owner-scoped list never could', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.callerToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgDeviceBody[];

    const theirs = body.find((d) => d.id === f.otherMemberDeviceId);
    expect(theirs).toBeDefined();
    expect(theirs?.name).toBe('sid-xeon-1');

    const mine = await app.fetch(get('/api/me/devices', f.callerToken));
    const mineBody = (await mine.json()) as Array<{ id: string }>;
    expect(mineBody.map((d) => d.id)).not.toContain(f.otherMemberDeviceId);
  });

  it('answers ownedByMe per row, true only for the device the caller paired', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.callerToken));
    const body = (await res.json()) as OrgDeviceBody[];

    expect(body.find((d) => d.id === f.myDeviceId)?.ownedByMe).toBe(true);
    expect(body.find((d) => d.id === f.otherMemberDeviceId)?.ownedByMe).toBe(false);
  });

  it('returns one row for a device bound to two of the org projects, naming both', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.callerToken));
    const body = (await res.json()) as OrgDeviceBody[];

    const rows = body.filter((d) => d.id === f.otherMemberDeviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runnerCount).toBe(2);
    expect([...(rows[0]?.projectNames ?? [])].sort()).toEqual([...f.visibleProjectNames].sort());
  });

  it('omits a device bound only to a project this caller cannot see', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.callerToken));
    const body = (await res.json()) as OrgDeviceBody[];

    expect(body.map((d) => d.id)).not.toContain(f.hiddenDeviceId);
    // The row exists and is in this org — what keeps it out is the visibility
    // predicate alone, so a widened WHERE fails exactly here.
    const stillThere = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM runners WHERE device_id = ${f.hiddenDeviceId}
    `)) as unknown as Array<{ n: number }>;
    expect(stillThere[0]?.n).toBe(1);
  });

  it('omits a paired device that serves no project, which has no runner row to reach it by', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.callerToken));
    const body = (await res.json()) as OrgDeviceBody[];

    expect(body.map((d) => d.id)).not.toContain(f.unboundDeviceId);

    const mine = await app.fetch(get('/api/me/devices', f.callerToken));
    const mineBody = (await mine.json()) as Array<{ id: string }>;
    expect(mineBody.map((d) => d.id)).toContain(f.unboundDeviceId);
  });

  it('refuses a caller who is not a member of the organisation', async () => {
    const f = await seed();

    const res = await app.fetch(get(`/api/orgs/${f.orgId}/devices`, f.outsiderToken));
    expect(res.status).toBe(403);
  });

  it('refuses an organisation that does not exist', async () => {
    const f = await seed();

    const res = await app.fetch(
      get('/api/orgs/00000000-0000-4000-8000-000000000000/devices', f.callerToken),
    );
    expect(res.status).toBe(404);
  });

  it('refuses a malformed orgId', async () => {
    const f = await seed();

    const res = await app.fetch(get('/api/orgs/not-a-uuid/devices', f.callerToken));
    expect(res.status).toBe(400);
  });

  it('answers empty for an organisation the caller belongs to with nothing visible in it', async () => {
    const f = await seed();
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${f.otherOrgId}, ${f.callerId}, 'member')
    `);

    const res = await app.fetch(get(`/api/orgs/${f.otherOrgId}/devices`, f.callerToken));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('GET /api/me/devices', () => {
  it('marks every row ownedByMe, so a surface reading both lists never has to guess', async () => {
    const f = await seed();

    const res = await app.fetch(get('/api/me/devices', f.callerToken));
    const body = (await res.json()) as Array<{ id: string; ownedByMe: boolean }>;

    expect(body.length).toBeGreaterThan(0);
    expect(body.every((d) => d.ownedByMe === true)).toBe(true);
  });
});
