/**
 * A judge is declared over a closed issue; a build never is (forge-core-61's ruling, 2026-10-29,
 * under `VISION: state-never-lies`: never reopen an issue so it can be judged). Since the fast lane,
 * a dev snapshot closes issues before the daily judge reaches them, and a run over a closed issue
 * beside one still in work was refused `ISSUE_AT_REST` as a take on the closed one (FB-273; ISS-576
 * admitted only a group closed throughout), so ten of K152's fifteen could not be judged. The run
 * names its role at declare: a `qa` run carries a closed issue untaken, reads its environment's
 * testing secret and posts verdicts on it, and moves no status; any other role is refused the closed
 * issue by name, alone or beside work. Against real Postgres, through the box's routes.
 *
 * @direct-test-of packages/core/src/devices/run-session.ts
 * @direct-test-of packages/core/src/issues/issue-resting.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { mintPat } from '../../src/credentials/pat.js';
import { deviceTokenNameFor } from '../../src/credentials/pat-format.js';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

type Doc = Record<string, unknown>;

const VALUE = 'dev-admin@forge.test:Corr3ct-H0rse-Battery';
const REF = 'secret://dev/admin';
const SHA = '1994aff73882b8368c19355ebbaa208dbc1cd5f4';

const world = { ownerId: '', projectId: '', box: '', boxToken: '', closedId: '' };

async function ok(r: Promise<{ status: number; body: unknown }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
}

const codes = (body: unknown): string[] =>
  (((body as { error?: { refusals?: Doc[] } }).error?.refusals ?? []) as Doc[]).map((r) =>
    String(r.code),
  );

const preflight = (issueKeys: string[], role?: string) =>
  api(world.boxToken, 'POST', '/api/devices/me/run-sessions/preflight', {
    projectId: world.projectId,
    issueKeys,
    ...(role ? { role } : {}),
  });

const declare = (runId: string, issueKeys: string[], role?: string) =>
  api(world.boxToken, 'POST', '/api/devices/me/run-sessions', {
    projectId: world.projectId,
    runId,
    issueKeys,
    name: `run-${runId.slice(0, 4)}`,
    ...(role ? { role } : {}),
  });

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return row?.status ?? 'missing';
}

async function leasesOn(key: string): Promise<number> {
  const [row] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM issue_leases WHERE project_id = ${world.projectId} AND issue_key = ${key}`);
  return row?.n ?? -1;
}

beforeEach(async () => {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.box = await createTestDevice(world.ownerId);
  await bindTestRunner(world.projectId, world.box);
  world.boxToken = (
    await mintPat({
      userId: world.ownerId,
      name: deviceTokenNameFor(world.box),
      scopes: ['read', 'write'],
      permissions: ['*'],
      projectIds: [],
      onBehalfOf: world.ownerId,
      deviceId: world.box,
    })
  ).plaintext;
  const token = await userToken(world.ownerId);
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/secrets/dev/admin`, { value: VALUE }),
  );
  await ok(
    api(token, 'PUT', `/api/projects/${world.projectId}/testing-profiles/dev`, {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'dev',
        actors: { admin: { role: 'project-admin', credential: REF } },
        services: {},
        limits: [],
      },
    }),
  );
  await seedProjectDocument(world.projectId, world.ownerId, {
    defaultBranch: 'main',
    environments: {
      dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' }, testing: 'dev' },
    },
  });
  const master = await api(world.boxToken, 'POST', '/api/devices/me/master-session', {
    projectId: world.projectId,
    name: 'forge-master-judge',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  // ISS-1: landed on dev and closed by a snapshot before any judge saw it; ISS-2: still in work
  const closed = await createTestIssue(world.projectId, world.ownerId, 1, {
    status: 'closed',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  world.closedId = closed.id;
  await db.execute(sql`UPDATE issues SET merged_target = 'dev' WHERE id = ${closed.id}`);
  await db.execute(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${closed.id}, 1, 'the page keeps the reference code on screen', 0)`);
  await createTestIssue(world.projectId, world.ownerId, 2, {
    status: 'in_progress',
    createdAt: new Date(),
  });
});

describe('a judge declared over a closed issue', () => {
  it('opens beside work, takes nothing on the closed issue, reads its secret and posts a verdict, and moves no status', async () => {
    const pre = await preflight(['ISS-2', 'ISS-1'], 'qa');
    expect([pre.status, codes(pre.body)], JSON.stringify(pre.body)).toEqual([200, []]);

    const runId = randomUUID();
    const opened = await declare(runId, ['ISS-2', 'ISS-1'], 'forge:qa');
    expect([opened.status, codes(opened.body)], JSON.stringify(opened.body)).toEqual([200, []]);
    expect(await leasesOn('ISS-1'), 'a judge took a lease on a closed issue').toBe(0);
    expect(await leasesOn('ISS-2')).toBe(1);

    const secrets = await api(
      world.boxToken,
      'GET',
      `/api/jobs/${runId}/testing-profiles/dev/secrets`,
    );
    expect(secrets.status, JSON.stringify(secrets.body)).toBe(200);
    expect(secrets.body).toMatchObject({
      environment: 'dev',
      secrets: [{ ref: REF, value: VALUE }],
    });

    // the judge's own call, as `independent-qa-verdict-e2e` posts one: a credential of the box
    const judge = (
      await mintPat({
        permissions: ['*'],
        userId: world.ownerId,
        name: 'judge',
        deviceId: world.box,
      })
    ).plaintext;
    const verdict = await api(judge, 'POST', `/api/issues/${world.closedId}/verdicts`, {
      criterion: 1,
      verdict: 'pass',
      reason: 'the reference code stays on screen on the served build',
      identity: { kind: 'commit', sha: SHA },
      judge: 'review',
      run: runId,
    });
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(201);
    expect(await statusOf(world.closedId), 'judging moved a closed issue').toBe('closed');
  });

  it('opens over closed issues alone as before', async () => {
    const opened = await declare(randomUUID(), ['ISS-1'], 'qa');
    expect([opened.status, codes(opened.body)]).toEqual([200, []]);
    expect(await leasesOn('ISS-1')).toBe(0);
  });
});

describe('a build declared over a closed issue', () => {
  it('is refused by name alone, at the preflight and at the open, and opens nothing', async () => {
    const pre = await preflight(['ISS-1'], 'runner');
    expect([pre.status, codes(pre.body)], JSON.stringify(pre.body)).toEqual([
      422,
      ['ISSUE_AT_REST'],
    ]);
    const said = JSON.stringify(pre.body);
    expect(said).toContain('ISS-1');
    expect(said).toContain('`runner`');
    expect(said).toContain('--role qa');

    const runId = randomUUID();
    const opened = await declare(runId, ['ISS-1'], 'forge:runner');
    expect(codes(opened.body)).toEqual(['ISSUE_AT_REST']);
    const [sessions] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pipeline_runs WHERE metadata->>'boxRunId' = ${runId}`);
    expect(sessions?.n).toBe(0);
  });

  it('is refused the closed issue beside work, and takes no lease on the work either', async () => {
    const opened = await declare(randomUUID(), ['ISS-2', 'ISS-1'], 'runner');
    expect(codes(opened.body)).toEqual(['ISSUE_AT_REST']);
    expect(await leasesOn('ISS-2')).toBe(0);
  });

  it('still opens over work alone and takes its lease', async () => {
    const opened = await declare(randomUUID(), ['ISS-2'], 'runner');
    expect([opened.status, codes(opened.body)]).toEqual([200, []]);
    expect(await leasesOn('ISS-2')).toBe(1);
  });
});
