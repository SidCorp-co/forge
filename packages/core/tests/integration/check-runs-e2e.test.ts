/**
 * The checks a run makes, recorded on its issue with their kind and duration (REQ-36 BC-14; Issue to
 * release r20 `act-build`; ISS-474): `POST /api/issues/:id/checks` records each check once, on the run
 * session holding the issue on the box that sent it, and refuses a check missing its duration or its
 * kind, or reusing a recorded check's id; `GET /api/issues/:id/checks` answers the time per kind.
 *
 * It reaches its subject over HTTP, so it names what it guards:
 * @direct-test-of packages/core/src/issues/check-runs.ts
 * @direct-test-of packages/core/src/issues/check-run-rules.ts
 * @direct-test-of packages/core/src/issues/check-run-routes.ts
 * @direct-test-of packages/core/src/db/schema-issue-check-runs.ts
 * @direct-test-of packages/contracts/src/check-runs.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { api, userToken } from '../helpers/api.js';
import {
  closeWorld,
  type Doc,
  refusedByDb,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const HEAD = 'a'.repeat(40);

let personToken = '';
let boxToken = '';
let userId = '';
let projectId = '';
let deviceId = '';
let seq = 0;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  const user = await createTestUser({ verified: true });
  userId = user.id;
  personToken = await userToken(user.id);
  projectId = (await createTestProject(user.id)).id;
  await addProjectMember(projectId, user.id, 'admin');
  deviceId = await createTestDevice(user.id);
  boxToken = (await mintPat({ permissions: ['*'], userId, name: 'box', deviceId })).plaintext;
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function issue(): Promise<{ id: string; key: string }> {
  seq += 1;
  return createTestIssue(projectId, userId, seq, { status: 'in_progress', createdAt: new Date() });
}

/** A run session on the box holding the issue's lease, as a declared run does. */
async function holdOnBox(key: string): Promise<string> {
  const runId = await createTestRunSession(projectId, deviceId, new Date(), null);
  const [session] = await rows<{ id: string }>(
    sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${runId}`,
  );
  if (!session) throw new Error('no run session seeded');
  await rows(sql`
    INSERT INTO issue_leases (project_id, issue_key, device_id, session_id, run_id)
    VALUES (${projectId}, ${key}, ${deviceId}, ${session.id}, ${runId})
    RETURNING session_id
  `);
  return session.id;
}

const check = (over: Doc = {}) => ({
  id: randomUUID(),
  kind: 'tests',
  name: 'direct-tests',
  scope: '@forge/core',
  command: 'pnpm exec vitest run <2 files>',
  files: ['packages/core/src/issues/a.test.ts'],
  result: 'pass',
  durationMs: 4200,
  startedAt: '2026-10-09T06:00:00.000Z',
  ...over,
});

const post = async (token: string, issueId: string, body: unknown) => {
  const res = await api(token, 'POST', `/api/issues/${issueId}/checks`, body);
  return { status: res.status, body: res.body as Doc };
};

const read = async (issueId: string) =>
  (await api(personToken, 'GET', `/api/issues/${issueId}/checks`)).body as Doc;

const codes = (res: { body: Doc }): string[] =>
  (res.body.error?.refusals ?? []).map((r: Doc) => r.code);

describe('a run records the checks it timed', () => {
  it('on the run session holding the issue on its box, each with its kind and duration', async () => {
    const target = await issue();
    const session = await holdOnBox(target.key);
    const sent = [
      check(),
      check({ kind: 'typecheck', name: 'typecheck', scope: 'typescript', durationMs: 9100 }),
      check({ kind: 'conformance', name: 'verify', scope: 'workspace', durationMs: 61000 }),
    ];
    const res = await post(boxToken, target.id, { head: HEAD, checks: sent });
    expect([res.status, res.body]).toEqual([
      201,
      { issueId: target.id, recorded: 3, alreadyRecorded: 0, runSessionId: session },
    ]);
    const view = await read(target.id);
    expect(view.totalMs).toBe(74300);
    expect(view.checks.every((c: Doc) => c.runSessionId === session && c.via === 'report')).toBe(
      true,
    );
    const kind = (k: string) => view.kinds.find((x: Doc) => x.kind === k);
    expect(kind('conformance')).toMatchObject({ checks: 1, totalMs: 61000 });
    expect(kind('conformance').slowest).toMatchObject({ name: 'verify', durationMs: 61000 });
    expect(kind('probes')).toEqual({ kind: 'probes', checks: 0, totalMs: 0, slowest: null });
    expect(view.kinds.map((k: Doc) => k.kind)).toEqual([
      'tests',
      'typecheck',
      'probes',
      'review',
      'conformance',
      'base',
    ]);
  });

  it('records a call from no run with no session, and says so', async () => {
    const target = await issue();
    const res = await post(personToken, target.id, { head: HEAD, checks: [check()] });
    expect([res.status, res.body.runSessionId]).toEqual([201, null]);
    expect((await read(target.id)).checks[0].runSessionId).toBeNull();
  });

  it('adds nothing for a check sent again: one check is one record', async () => {
    const target = await issue();
    await holdOnBox(target.key);
    const once = check();
    expect((await post(boxToken, target.id, { head: HEAD, checks: [once] })).status).toBe(201);
    const again = await post(boxToken, target.id, { head: HEAD, checks: [once, check()] });
    expect([again.status, again.body.recorded, again.body.alreadyRecorded]).toEqual([201, 1, 1]);
    const resent = await post(boxToken, target.id, { head: HEAD, checks: [once] });
    expect([resent.status, resent.body.recorded]).toEqual([200, 0]);
    const counted = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue_check_runs WHERE id = ${once.id}`,
    );
    expect(counted[0]?.n).toBe(1);
    expect((await read(target.id)).checks).toHaveLength(2);
  });
});

/** The `issue.updated` events naming `checks` the outbox holds for one issue. */
const checksEvents = async (issueId: string) =>
  rows<{ fields: string[] }>(sql`
    SELECT payload->'fields' AS fields FROM pipeline_outbox
    WHERE issue_id = ${issueId} AND type = 'issue.updated' AND payload->'fields' ? 'checks'
  `);

describe('an open issue page hears that checks were recorded', () => {
  it('a call that adds a check emits issue.updated naming checks, once per call', async () => {
    const target = await issue();
    const sent = check();
    await post(personToken, target.id, { head: HEAD, checks: [sent, check()] });
    expect(await checksEvents(target.id)).toEqual([{ fields: ['checks'] }]);
    const resent = await post(personToken, target.id, { head: HEAD, checks: [sent] });
    expect(resent.body.recorded).toBe(0);
    expect(await checksEvents(target.id)).toHaveLength(1);
  });

  it('a refused call emits nothing', async () => {
    const target = await issue();
    await post(personToken, target.id, { head: HEAD, checks: [check({ kind: 'lint' })] });
    expect(await checksEvents(target.id)).toEqual([]);
  });
});

describe('a check the record refuses, writing nothing', () => {
  it('refuses one with no duration, naming it', async () => {
    const target = await issue();
    const { durationMs: _, ...untimed } = check();
    const res = await post(personToken, target.id, { head: HEAD, checks: [check(), untimed] });
    expect(res.status).toBe(400);
    expect(res.body.error.refusals.map((r: Doc) => r.path)).toContain('/checks/1/durationMs');
    expect((await read(target.id)).checks).toEqual([]);
  });

  it('refuses one with a kind outside the list, naming the kinds', async () => {
    const target = await issue();
    const res = await post(personToken, target.id, {
      head: HEAD,
      checks: [check({ kind: 'lint' })],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'kind is one of tests, typecheck, probes, review, conformance, base',
    );
  });

  it('refuses an id recorded as another check, by name and with 409', async () => {
    const target = await issue();
    const first = check();
    await post(personToken, target.id, { head: HEAD, checks: [first] });
    const fresh = check();
    const res = await post(personToken, target.id, {
      head: HEAD,
      checks: [fresh, { ...first, durationMs: 1 }],
    });
    expect([res.status, codes(res)]).toEqual([409, ['CHECK_RUN_CONFLICT']]);
    expect(res.body.error.refusals[0].path).toBe('/checks/1/id');
    expect((await read(target.id)).checks.map((c: Doc) => c.id)).toEqual([first.id]);
  });

  it('refuses a `run` naming no live session of the box', async () => {
    const target = await issue();
    const res = await post(boxToken, target.id, {
      head: HEAD,
      run: randomUUID(),
      checks: [check()],
    });
    expect([res.status, codes(res)]).toEqual([422, ['CHECK_RUN_UNKNOWN']]);
  });

  it('keeps a recorded check as it was: the table refuses an update', async () => {
    const target = await issue();
    const sent = check();
    await post(personToken, target.id, { head: HEAD, checks: [sent] });
    await refusedByDb(
      rows(sql`UPDATE issue_check_runs SET duration_ms = 1 WHERE id = ${sent.id}`),
      /ISSUE_CHECK_RUN_IMMUTABLE/,
    );
  });
});
