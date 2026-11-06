/**
 * ISS-1036 (adminhub-fe FB-508, reopened on 0.4.0-dev.539): a master ran `forge-runner run declare
 * --issue ISS-119 --role reviewer`, got run ea1b1d57-…, and POSTed a verdict naming that whole id
 * with no subagent dispatched under it. Core answered VERDICT_RUN_UNKNOWN "this box has declared no
 * live run over ISS-119", which was false: the box had just declared it.
 *
 * Core holds a declared run only once its box opens the run's session (`POST
 * /api/devices/me/run-sessions`, `devices/run-session.ts:openRunSession`, which writes the run and
 * its session in one transaction). The box's `run declare` sent core only the preflight, which
 * writes nothing, and left the open to its next sweep; so between the declare and that sweep core
 * knew of no such run. These cases replay both halves through the app's own routes, against real
 * Postgres: the declare as an older box sends it (preflight alone), which core can only refuse and
 * must refuse truthfully, and the declare as a box sends it from ISS-1036 (preflight, then the open
 * before `run declare` answers), which records with nothing dispatched under the run.
 *
 * @direct-test-of packages/core/src/issues/pattern-runs.ts
 * @direct-test-of packages/core/src/issues/criteria/recording-session.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  makeAgreeReady,
  seedIssueStatus,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

const BUILT = '2222222222222222222222222222222222222222';

let projectId = '';
let person = '';
let box = '';
let otherBox = '';
let req = '';
const ids = new Map<number, string>();

async function boxCredential(ownerId: string, name: string): Promise<string> {
  const { mintPat } = await import('../../src/credentials/pat.js');
  const deviceId = await createTestDevice(ownerId);
  await bindTestRunner(projectId, deviceId);
  const pat = (
    await mintPat({ permissions: ['*'], userId: ownerId, name, deviceId, projectIds: [projectId] })
  ).plaintext;
  const master = await api(pat, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: `forge-master-${name}`,
    maxJobPanes: 3,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
  return pat;
}

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
      title: 'Sites by name',
      reason: 'planted',
      criteria: [{ body: 'The site list shows each site name' }],
    }),
  );
  const key = String(created.key);
  await makeAgreeReady(projectId, Number(key.slice(4)), ownerId);
  await ok(on(`/requirements/${key}/revisions/1/propose`, {}));
  await ok(on(`/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }));
  await ok(on(`/requirements/${key}/agree`, { revision: 1, reason: 'Agreed for this test.' }));
  return key;
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  plantLiveBuild('9999999999999999999999999999999999999999', { [BUILT]: true });
  const admin = await createTestUser({ verified: true });
  projectId = await projectBuiltFrom(admin.id, null);
  await addProjectMember(projectId, admin.id, 'admin');
  person = await userToken(admin.id);
  for (const seq of [119, 120, 121, 122]) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status: 'in_progress',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await replaceCriteria(issue.id, [
      { n: 1, statement: 'The site list shows each site name' },
      { n: 2, statement: 'Each site row links to its own page' },
    ]);
    await seedIssueStatus(issue.id, 'awaiting_release');
    ids.set(seq, issue.id);
  }
  box = await boxCredential(admin.id, 'adminhub-fe');
  otherBox = await boxCredential(admin.id, 'adminhub-fe-2');
  req = await agreedRequirement(admin.id);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

interface Declared {
  runId: string;
  sessionId: string | null;
}

/**
 * `forge-runner run declare --issue <keys> --role reviewer` as the box sends it to core: the
 * preflight, and, where `opens`, the open of the run's session before the declare answers (ISS-1036).
 */
async function declare(
  credential: string,
  keys: string[],
  opts: { opens: boolean; runId?: string; role?: string; requirement?: string } = { opens: true },
): Promise<Declared> {
  const role = opts.role ?? 'reviewer';
  const runId = opts.runId ?? randomUUID();
  const at = opts.requirement ? { requirement: opts.requirement } : {};
  await ok(
    api(credential, 'POST', '/api/devices/me/run-sessions/preflight', {
      projectId,
      issueKeys: keys,
      role,
      ...at,
    }),
  );
  if (!opts.opens) return { runId, sessionId: null };
  const opened = await ok(
    api(credential, 'POST', '/api/devices/me/run-sessions', {
      projectId,
      runId,
      issueKeys: keys,
      name: `${(keys[0] ?? opts.requirement)?.toLowerCase()}-${role}`,
      role,
      ...at,
    }),
  );
  return { runId, sessionId: String(opened.sessionId) };
}

const verdict = (
  seq: number,
  run: string,
  more: { criterion?: number; judge?: 'review' | 'qa'; credential?: string } = {},
) =>
  api(more.credential ?? box, 'POST', `/api/issues/${ids.get(seq)}/verdicts`, {
    criterion: more.criterion ?? 2,
    verdict: 'pass',
    reason: 'every site row links to its own page in the diff',
    identity: { kind: 'commit', sha: BUILT },
    evidence: ['sites.png'],
    judge: more.judge ?? 'review',
    run,
  });

const refusalsOf = (res: { body: unknown }) =>
  ((res.body as Doc).error?.refusals ?? []) as Array<{ code: string; detail: string }>;

async function recorded(
  verdictId: string,
): Promise<{ session: string | null; role: string | null }> {
  const [r] = (await db.execute(sql`
    SELECT v.run_session_id, r.metadata ->> 'role' AS role
      FROM criterion_verdicts v
      LEFT JOIN agent_sessions s ON s.id = v.run_session_id
      LEFT JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE v.id = ${verdictId}
  `)) as unknown as Array<{ run_session_id: string | null; role: string | null }>;
  return { session: r?.run_session_id ?? null, role: r?.role ?? null };
}

describe('ISS-1036 a verdict under a run its box declared and dispatched nothing under', () => {
  let unopened: Declared = { runId: '', sessionId: null };

  it('refuses the declare an older box sends (no open) without saying the box declared no run', async () => {
    // The reporter's sequence: declare, dispatch nothing, POST naming the whole declared id.
    unopened = await declare(box, ['ISS-119'], {
      opens: false,
      runId: 'ea1b1d57-97a8-4c6d-bcf6-035c178b55e7',
    });

    const res = await verdict(119, unopened.runId);

    const [refusal] = refusalsOf(res);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).not.toContain('declared no live run');
    expect(refusal?.detail).toContain(
      `core holds no run of this box on this project named ${unopened.runId}`,
    );
    expect(refusal?.detail).toContain('opens its session at core');
    expect(refusal?.detail).toContain('leave `run` out');
  });

  let reviewer: Declared = { runId: '', sessionId: null };

  it('records the verdict under the run as a box declares it from ISS-1036, nothing dispatched under it', async () => {
    reviewer = await declare(box, ['ISS-119'], { opens: true });

    const res = await verdict(119, reviewer.runId);

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await recorded(String((res.body as Doc).verdictId))).toEqual({
      session: reviewer.sessionId,
      role: 'reviewer',
    });
  });

  it('records it the same under the run’s first eight characters', async () => {
    const res = await verdict(119, reviewer.runId.slice(0, 8), { criterion: 1 });

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect((await recorded(String((res.body as Doc).verdictId))).session).toBe(reviewer.sessionId);
  });

  it('reads the recorded verdict as the reviewer run’s judgement, never another role’s', async () => {
    const res = await verdict(119, reviewer.runId, { judge: 'qa' });

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_JUDGE_NOT_RUN_ROLE');
    expect(refusal?.detail).toContain(
      `by run ${reviewer.runId}, which was declared \`--role reviewer\``,
    );
  });

  it('refuses another box’s declared run, naming that it is another box’s', async () => {
    const theirs = await declare(otherBox, ['ISS-121'], { opens: true });

    const res = await verdict(121, theirs.runId);

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      `run ${theirs.runId} is a run of another box on this project`,
    );
    expect(refusal?.detail).not.toContain('declared no live run');
  });

  it('refuses a declared run that has closed, naming that it ended', async () => {
    const closing = await declare(box, ['ISS-120'], { opens: true });
    await ok(
      api(box, 'POST', `/api/devices/me/run-sessions/${closing.sessionId}/close`, {
        outcome: 'ended',
      }),
    );

    const res = await verdict(120, closing.runId);

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(`run ${closing.runId} is this box's, and it ended`);
  });

  it('refuses a run declared over a different issue, naming the runs declared over this one', async () => {
    const over122 = await declare(box, ['ISS-122'], { opens: true });

    const res = await verdict(122, reviewer.runId);

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      `run ${reviewer.runId} was declared over ISS-119, not ISS-122`,
    );
    expect(refusal?.detail).toContain(over122.runId);
  });
});

describe('ISS-1036 the requirement door reads a declared run the same way', () => {
  const judge = (run: string) =>
    api(box, 'POST', `/api/projects/${projectId}/requirements/${req}/verdicts`, {
      criterion: 'BC-1',
      verdict: 'pass',
      reason: 'pass on the running build',
      identity: { kind: 'commit', sha: BUILT },
      evidence: ['https://forge-dev.example/clips/sites.webm'],
      run,
    });

  it('refuses a run core has not been told of without saying the box declared none', async () => {
    const res = await judge(randomUUID());

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).not.toContain('declared no live run');
    expect(refusal?.detail).toContain('opens its session at core');
  });

  it('records under a run opened at its declare, nothing dispatched under it', async () => {
    // A judge at the requirement is declared over it rather than over an issue (ISS-735).
    const opened = await declare(box, [], { opens: true, role: 'qa', requirement: req });

    const res = await judge(opened.runId);

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const [row] = (await db.execute(sql`
      SELECT run_session_id FROM requirement_criterion_verdicts ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<{ run_session_id: string | null }>;
    expect(row?.run_session_id).toBe(opened.sessionId);
  });
});
