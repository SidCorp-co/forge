/**
 * ISS-777: a declared qa judge names its run by the id the plugin minted for its tree. The master
 * declares the run (`forge-runner run declare --role qa`, which opens its session at core through
 * the box's own door), the box binds the dispatched subagent to it in its ledger (nothing reaches
 * core), and the subagent, handed only `FORGE_SESSION_ID=iss-<n>-<hex>` by `forge brief`, posts its
 * verdict with that as `run`. adminhub-fe ISS-112 (dev core, 2026-10-30): run a2228705 was declared,
 * the judge sent `run=iss-112-d65cfcc4`, was refused VERDICT_RUN_UNKNOWN, and posted its verdicts
 * run-less, where they were read as the builder's and did not count.
 *
 * @direct-test-of packages/core/src/issues/pattern-runs.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api } from '../helpers/api.js';
import { closeWorld, type Doc, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
  seedIssueStatus,
} from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

const BUILT = '2222222222222222222222222222222222222222';

let projectId = '';
let box = '';
const ids = new Map<number, string>();

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  plantLiveBuild('9999999999999999999999999999999999999999', { [BUILT]: true });
  const { mintPat } = await import('../../src/credentials/pat.js');
  const admin = await createTestUser({ verified: true });
  projectId = await projectBuiltFrom(admin.id, null);
  await addProjectMember(projectId, admin.id, 'admin');
  const deviceId = await createTestDevice(admin.id);
  await bindTestRunner(projectId, deviceId);
  box = (
    await mintPat({
      permissions: ['*'],
      userId: admin.id,
      name: 'box-judge',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  for (const [seq, status] of [
    [112, 'awaiting_release'],
    [7, 'closed'],
  ] as const) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status: 'in_progress',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await replaceCriteria(issue.id, [{ n: 1, statement: 'A card reveals its number once' }]);
    // planted where the work stands when its judge is declared, past the step that writes criteria
    await seedIssueStatus(issue.id, status);
    ids.set(seq, issue.id);
  }
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-adminhub',
    maxJobPanes: 2,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** `forge-runner run declare --role qa`: the box opens the declared run's session at core. */
async function declareJudge(issueKey: string): Promise<{ runId: string; sessionId: string }> {
  const runId = randomUUID();
  const opened = await api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys: [issueKey],
    name: `${issueKey.toLowerCase()}-judge`,
    role: 'qa',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { runId, sessionId: String((opened.body as Doc).sessionId) };
}

const verdict = (seq: number, run: string) =>
  api(box, 'POST', `/api/issues/${ids.get(seq)}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'pass on the running build',
    identity: { kind: 'commit', sha: BUILT },
    evidence: ['shot.png'],
    judge: 'review',
    run,
  });

const refusalsOf = (res: { body: unknown }) =>
  ((res.body as Doc).error?.refusals ?? []) as Array<{ code: string; detail: string }>;

async function recordedSession(verdictId: string): Promise<string | null> {
  const [r] = (await db.execute(
    sql`SELECT run_session_id FROM criterion_verdicts WHERE id = ${verdictId}`,
  )) as unknown as Array<{ run_session_id: string | null }>;
  return r?.run_session_id ?? null;
}

describe('ISS-777 a judge names its declared run by the id minted for its tree', () => {
  it('records the verdict as the declared qa run when it sends the minted id', async () => {
    const judge = await declareJudge('ISS-112');
    // the box binds the dispatched subagent to the run in its own ledger; core is told nothing

    const res = await verdict(112, 'iss-112-d65cfcc4');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await recordedSession(String((res.body as Doc).verdictId))).toBe(judge.sessionId);
  });

  it('refuses a minted id two live runs of the box are declared over, naming each declared id', async () => {
    const first = await declareJudge('ISS-7');
    const second = await declareJudge('ISS-7');

    const res = await verdict(7, 'iss-7-0a1b2c3d');

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      '2 live runs of this box on this project are declared over ISS-7',
    );
    expect(refusal?.detail).toContain(first.runId);
    expect(refusal?.detail).toContain(second.runId);
  });

  it('refuses a minted id no live run of the box is declared over, naming the issue', async () => {
    const res = await verdict(112, 'iss-113-0a1b2c3d');

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      'no live run of this box on this project is declared over ISS-113',
    );
  });
});
