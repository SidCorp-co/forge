/**
 * ISS-1139 — giving a lease back, over the wire a box actually uses.
 *
 * Every assertion here goes through `/api/devices/me/issue-leases/:issueKey`
 * with a device credential, because the two defects this closes are the
 * route's: the key the pool hands a box is the project's own prefixed one
 * while the store holds the canonical `ISS-<seq>`, and a delete that matched
 * nothing answered `200 {"ok":true}`. A call to `releaseIssueLease` would
 * prove the function and say nothing about what the runner reads.
 *
 * Real Postgres on purpose: what is being proved is which ROWS survive a
 * delete, and the project a row belongs to is the primary key's own column.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
let assignIssuePrefix: typeof import('../../src/issues/issue-prefix-service.js').assignIssuePrefix;

let userId: string;
let deviceId: string;
let auth: Record<string, string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
  ({ openRunSession } = await import('../../src/devices/run-session.js'));
  ({ assignIssuePrefix } = await import('../../src/issues/issue-prefix-service.js'));
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: userId, name: 'lease-box', platform: 'linux' });
  deviceId = issued.device.id;
  auth = { Authorization: `Bearer ${issued.plaintext}` };
});

/** A project this box serves, carrying one draft issue at `seq`. */
async function aProjectThisBoxServes(seq: number, prefix?: string): Promise<string> {
  const project = await createTestProject(harness.db, userId);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, name, type, status)
    VALUES (${randomUUID()}, ${project.id}, ${deviceId}, ${`r-${seq}-${project.id.slice(0, 8)}`},
            'claude-code', 'online')
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${randomUUID()}, ${project.id}, ${seq}, ${`issue ${seq}`}, 'draft', ${userId})
  `);
  if (prefix) {
    const assigned = await assignIssuePrefix(project.id, prefix);
    if (!assigned.ok) throw new Error(`the fixture could not hold the prefix ${prefix}`);
  }
  return project.id;
}

/** Which projects hold a lease row on this canonical key. */
async function leaseProjectsFor(issueKey: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT project_id FROM issue_leases WHERE issue_key = ${issueKey} ORDER BY project_id
  `)) as unknown as Array<{ project_id: string }>;
  return rows.map((r) => String(r.project_id)).sort();
}

/** The run that holds one project's lease on this key. */
async function runIdOfLease(projectId: string, issueKey = 'ISS-880'): Promise<string> {
  const rows = (await harness.db.execute(sql`
    SELECT run_id FROM issue_leases WHERE project_id = ${projectId} AND issue_key = ${issueKey}
  `)) as unknown as Array<{ run_id: string }>;
  return String(rows[0]?.run_id);
}

const lease = (key: string, projectId?: string) =>
  `/api/devices/me/issue-leases/${key}${projectId ? `?projectId=${projectId}` : ''}`;

type Refusal = { code?: string; message?: string; details?: unknown };

describe('the key the pool handed the box reaches the lease the store holds', () => {
  it('releases the lease a prefixed key names', async () => {
    const project = await aProjectThisBoxServes(880, 'FD');
    await openRunSession({
      deviceId,
      projectId: project,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const res = await app.request(lease('FD-880'), { method: 'DELETE', headers: auth });

    expect(
      res.status,
      'a 200 over a row that is still there is what the box reads as given back',
    ).toBe(200);
    expect(await leaseProjectsFor('ISS-880')).toEqual([]);
  });

  it('reports a prefixed key as held by this box', async () => {
    const project = await aProjectThisBoxServes(880, 'FD');
    await openRunSession({
      deviceId,
      projectId: project,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const res = await app.request(lease('FD-880'), { headers: auth });

    expect(await res.json()).toMatchObject({ held: true, heldByThisDevice: true });
  });

  it('still answers 200 with ok true when a row really went', async () => {
    const project = await aProjectThisBoxServes(880);
    await openRunSession({
      deviceId,
      projectId: project,
      issueKeys: ['ISS-880'],
      name: 'run-a',
    });

    const res = await app.request(lease('ISS-880'), { method: 'DELETE', headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('a release that matched no lease says so', () => {
  it('refuses a delete that removed nothing', async () => {
    await aProjectThisBoxServes(880);

    const res = await app.request(lease('ISS-880'), { method: 'DELETE', headers: auth });

    expect(
      res.status,
      'the runner reads a 200 here as the issue handed back and stops watching it',
    ).toBe(404);
  });

  it('names the canonical key it looked for', async () => {
    await aProjectThisBoxServes(880, 'FD');

    const res = await app.request(lease('FD-880'), { method: 'DELETE', headers: auth });
    const body = (await res.json()) as Refusal;

    expect(
      `${body.message}`,
      'a refusal whose whole job is naming the key has to name the one the store holds',
    ).toContain('ISS-880');
  });
});

describe('a key that names no project this box reaches', () => {
  it('refuses the read rather than calling the issue free', async () => {
    await aProjectThisBoxServes(880);

    const res = await app.request(lease('ZZ-880'), { headers: auth });

    expect(res.status).toBe(404);
    expect(((await res.json()) as Refusal).code).toBe('ISSUE_LEASE_KEY_UNKNOWN_PREFIX');
  });

  it('refuses the release rather than answering ok', async () => {
    await aProjectThisBoxServes(880);

    const res = await app.request(lease('ZZ-880'), { method: 'DELETE', headers: auth });

    expect(res.status).toBe(404);
    expect(((await res.json()) as Refusal).code).toBe('ISSUE_LEASE_KEY_UNKNOWN_PREFIX');
  });

  it('answers about a project out of this box reach rather than refusing it', async () => {
    await aProjectThisBoxServes(880);
    const elsewhere = (await createTestProject(harness.db, userId)).id;
    const assigned = await assignIssuePrefix(elsewhere, 'ZZ');
    if (!assigned.ok) throw new Error('the fixture could not hold the prefix ZZ');

    const res = await app.request(lease('ZZ-880'), { headers: auth });

    expect(res.status).toBe(200);
    expect(
      await res.json(),
      'this box holds nothing there, which is the true answer; a refusal here would make a release destroy the permission to read it back',
    ).toMatchObject({ held: false, heldByThisDevice: false });
  });

  it('still reaches a lease in a project whose binding has gone', async () => {
    const project = await aProjectThisBoxServes(880, 'FD');
    await openRunSession({ deviceId, projectId: project, issueKeys: ['ISS-880'], name: 'run-a' });
    await harness.db.execute(sql`DELETE FROM runners WHERE device_id = ${deviceId}`);

    const res = await app.request(lease('FD-880'), { method: 'DELETE', headers: auth });

    expect(
      res.status,
      'a box unbound while it was working strands the lease if reachability is the binding alone',
    ).toBe(200);
    expect(await leaseProjectsFor('ISS-880')).toEqual([]);
  });

  it('answers the read-back after an unbound box gave its last lease away', async () => {
    const project = await aProjectThisBoxServes(880, 'FD');
    await openRunSession({ deviceId, projectId: project, issueKeys: ['ISS-880'], name: 'run-a' });
    await harness.db.execute(sql`DELETE FROM runners WHERE device_id = ${deviceId}`);
    await app.request(lease('FD-880'), { method: 'DELETE', headers: auth });

    const res = await app.request(lease('FD-880', project), { headers: auth });

    expect(
      res.status,
      'the close loop reads the lease back after releasing it, and an error there is a run that never marks itself closed',
    ).toBe(200);
    expect(await res.json()).toMatchObject({ heldByThisDevice: false });
  });

  it('refuses a key that is no issue reference at all', async () => {
    await aProjectThisBoxServes(880);

    const res = await app.request(lease('not-a-key'), { method: 'DELETE', headers: auth });

    expect(res.status).toBe(400);
  });
});

describe('one key, two projects, one box', () => {
  /** Both projects hold `ISS-880`, and this box is running both. */
  async function bothHeld(): Promise<{ left: string; right: string }> {
    const left = await aProjectThisBoxServes(880);
    const right = await aProjectThisBoxServes(880, 'FD');
    for (const projectId of [left, right]) {
      await openRunSession({
        deviceId,
        projectId,
        issueKeys: ['ISS-880'],
        name: `run-${projectId}`,
      });
    }
    return { left, right };
  }

  it('refuses a release that names neither project', async () => {
    const { left, right } = await bothHeld();

    const res = await app.request(lease('ISS-880'), { method: 'DELETE', headers: auth });
    const body = (await res.json()) as Refusal;

    expect(res.status).toBe(409);
    expect(`${body.message}`).toContain(left);
    expect(`${body.message}`).toContain(right);
  });

  it('leaves both leases standing when it refuses', async () => {
    const { left, right } = await bothHeld();

    await app.request(lease('ISS-880'), { method: 'DELETE', headers: auth });

    expect(await leaseProjectsFor('ISS-880')).toEqual([left, right].sort());
  });

  it('reads the lease of the project the caller named', async () => {
    const { left, right } = await bothHeld();

    const answered: string[] = [];
    for (const projectId of [right, left]) {
      const res = await app.request(lease('ISS-880', projectId), { headers: auth });
      const body = (await res.json()) as { holder: { runId: string } | null };
      answered.push(String(body.holder?.runId));
    }

    expect(
      answered,
      'a read that tie-breaks across projects answers about a lease the caller did not mean, and the close loop then waits on a release it never asked for',
    ).toEqual([await runIdOfLease(right), await runIdOfLease(left)]);
  });

  it('refuses a release whose prefix and projectId name different projects', async () => {
    const { left } = await bothHeld();

    const res = await app.request(lease('FD-880', left), { method: 'DELETE', headers: auth });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Refusal).code).toBe('ISSUE_LEASE_KEY_PROJECT_MISMATCH');
  });

  it('removes no lease when it refuses that mismatch', async () => {
    const { left, right } = await bothHeld();

    await app.request(lease('FD-880', left), { method: 'DELETE', headers: auth });

    expect(await leaseProjectsFor('ISS-880')).toEqual([left, right].sort());
  });

  it('refuses a read whose prefix and projectId name different projects', async () => {
    const { left } = await bothHeld();

    const res = await app.request(lease('FD-880', left), { headers: auth });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Refusal).code).toBe('ISSUE_LEASE_KEY_PROJECT_MISMATCH');
  });
});
