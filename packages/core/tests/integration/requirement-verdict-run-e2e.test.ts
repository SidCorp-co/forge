/**
 * A verdict at the requirement names the run that took it, as a verdict on an issue criterion does
 * (REQ-79 judge K157 on dev, ISS-808 fixture): the requirement door's strict body refused `run`, so a
 * declared judge's business-criterion verdicts were nobody's run. The `run` is the same field and is
 * held to the same rule as an issue verdict's (`issues/pattern-runs.ts:runOfCall`): it names a live
 * run of the calling box on this project, a person's call names none, and a box's call naming none
 * records none. Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/requirements/verdicts.ts
 * @direct-test-of packages/core/src/requirements/verdict-routes.ts
 * @direct-test-of packages/core/src/issues/criteria/recording-session.ts
 * @direct-test-of packages/core/src/db/schema-requirement-verdicts.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';

const LIVE = '9999999999999999999999999999999999999999';
const SHIPPED = '1111111111111111111111111111111111111111';

let projectId = '';
let person = '';
let box = '';
let req = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  plantLiveBuild(LIVE, { [SHIPPED]: true });
  const { mintPat } = await import('../../src/credentials/pat.js');
  const owner = await createTestUser({ verified: true });
  projectId = (await createTestProject(owner.id)).id;
  await addProjectMember(projectId, owner.id, 'admin');
  person = await userToken(owner.id);
  const deviceId = await createTestDevice(owner.id);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: owner.id,
      name: 'box-judge',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  await createTestIssue(projectId, owner.id, 808, { status: 'in_progress', createdAt: new Date() });
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-requirements',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  req = await agreedRequirement(owner.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function ok(r: Promise<{ status: number; body: unknown }>): Promise<Doc> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body as Doc;
}

async function agreedRequirement(ownerId: string): Promise<string> {
  const on = (path: string, body: unknown) =>
    api(person, 'POST', `/api/projects/${projectId}${path}`, body);
  const created = await ok(
    on('/requirements', {
      title: 'Fast delivery',
      reason: 'planted',
      criteria: [{ body: 'A change lands when it builds' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(on(`/requirements/${key}/revisions/1/propose`, {}));
  await ok(on(`/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }));
  await ok(on(`/requirements/${key}/agree`, { revision: 1, reason: 'Agreed for this test.' }));
  return key;
}

/** `forge-runner run declare --role qa` over the fixture issue: the box opens the run's session. */
async function declareJudge(): Promise<{ runId: string; sessionId: string }> {
  const runId = randomUUID();
  const opened = await api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys: ['ISS-808'],
    name: 'iss-808-judge',
    role: 'qa',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { runId, sessionId: String((opened.body as Doc).sessionId) };
}

const judge = (credential: string, more: Record<string, unknown> = {}) =>
  api(credential, 'POST', `/api/projects/${projectId}/requirements/${req}/verdicts`, {
    criterion: 'BC-1',
    verdict: 'pass',
    reason: 'pass on the running build',
    identity: { kind: 'commit', sha: SHIPPED },
    evidence: ['https://forge-dev.example/clips/land.webm'],
    ...more,
  });

const refusalsOf = (res: { body: unknown }) =>
  ((res.body as Doc).error?.refusals ?? []) as Array<{
    code: string;
    path: string;
    detail: string;
  }>;

async function recordedRuns(): Promise<Array<string | null>> {
  const rows = (await db.execute(sql`
    SELECT run_session_id FROM requirement_criterion_verdicts ORDER BY created_at
  `)) as unknown as Array<{ run_session_id: string | null }>;
  return rows.map((r) => r.run_session_id);
}

describe('a verdict at the requirement names the run that took it, as an issue verdict does', () => {
  it("records the declared run the box's call names, and the list answers it", async () => {
    const before = (await recordedRuns()).length;
    const { runId, sessionId } = await declareJudge();

    const res = await judge(box, { run: runId });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await recordedRuns()).slice(before)).toEqual([sessionId]);
    const listed = await ok(
      api(box, 'GET', `/api/projects/${projectId}/requirements/${req}/verdicts`),
    );
    const mine = (listed.verdicts as Doc[]).find((v) => v.id === (res.body as Doc).verdictId);
    expect(mine?.run).toBe(sessionId);
  });

  it("refuses a run that is no live run of this box, by the issue door's code, writing nothing", async () => {
    const before = await recordedRuns();
    const stray = randomUUID();

    const res = await judge(box, { run: stray });

    expect(res.status).toBe(422);
    const [refusal] = refusalsOf(res);
    expect([refusal?.code, refusal?.path]).toEqual(['VERDICT_RUN_UNKNOWN', '/run']);
    expect(refusal?.detail).toContain(`\`run\` ${stray} is no live session of this box`);
    expect(await recordedRuns()).toEqual(before);
  });

  it("refuses a run on a person's call: a person is no run", async () => {
    const before = await recordedRuns();

    const res = await judge(person, { run: randomUUID() });

    expect(res.status).toBe(422);
    expect(refusalsOf(res).map((r) => r.code)).toEqual(['VERDICT_RUN_UNKNOWN']);
    expect(refusalsOf(res)[0]?.detail).toContain("a person's credential");
    expect(await recordedRuns()).toEqual(before);
  });

  it("records no run where the box's call names none", async () => {
    const before = (await recordedRuns()).length;

    const res = await judge(box);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await recordedRuns()).slice(before)).toEqual([null]);
  });
});
