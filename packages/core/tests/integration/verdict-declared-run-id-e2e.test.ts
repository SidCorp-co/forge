/**
 * ISS-998 (adminhub-fe FB-508): a reviewer run declared on the box (`forge-runner run declare --role
 * reviewer`, run f5dc2591, over ISS-111 and ISS-125) posted verdicts naming its run as the box shows
 * it, and was refused VERDICT_RUN_UNKNOWN; the same body naming the brief's session id was accepted.
 * A box names a run by its whole id or by its first eight characters (`runner-core` ledger
 * `SHORT_ID_CHARS`), so the verdict door takes either, and a refusal names the whole ids it wants.
 * Through the app's own routes, against real Postgres.
 *
 * @direct-test-of packages/core/src/issues/pattern-runs.ts
 * @direct-test-of packages/core/src/issues/criteria/recording-session.ts
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
      name: 'box-reviewer',
      deviceId,
      projectIds: [projectId],
    })
  ).plaintext;
  for (const seq of [111, 125, 200, 300]) {
    const issue = await createTestIssue(projectId, admin.id, seq, {
      status: 'in_progress',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await replaceCriteria(issue.id, [{ n: 1, statement: 'The site list shows each site name' }]);
    await seedIssueStatus(issue.id, 'awaiting_release');
    ids.set(seq, issue.id);
  }
  const master = await api(box, 'POST', '/api/devices/me/master-session', {
    projectId,
    name: 'forge-master-adminhub',
    maxJobPanes: 3,
  });
  expect(master.status, JSON.stringify(master.body)).toBe(200);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** `forge-runner run declare --role reviewer` over `keys`: the box opens the run's session at core. */
async function declare(
  keys: string[],
  runId: string = randomUUID(),
): Promise<{ runId: string; sessionId: string }> {
  const opened = await api(box, 'POST', '/api/devices/me/run-sessions', {
    projectId,
    runId,
    issueKeys: keys,
    name: `${keys[0]?.toLowerCase()}-review`,
    role: 'reviewer',
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return { runId, sessionId: String((opened.body as Doc).sessionId) };
}

const verdict = (seq: number, run: string) =>
  api(box, 'POST', `/api/issues/${ids.get(seq)}/verdicts`, {
    criterion: 1,
    verdict: 'pass',
    reason: 'every site is listed by its name on the running build',
    identity: { kind: 'commit', sha: BUILT },
    evidence: ['sites.png'],
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

let reviewer = { runId: '', sessionId: '' };

describe('ISS-998 a verdict names its declared run as the box names it', () => {
  it('records a verdict naming the whole declared run id as that run', async () => {
    reviewer = await declare(['ISS-111', 'ISS-125'], `f5dc2591-${randomUUID().slice(9)}`);

    const res = await verdict(111, reviewer.runId);

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await recordedSession(String((res.body as Doc).verdictId))).toBe(reviewer.sessionId);
  });

  it('records a verdict naming the declared run by its first eight characters as that run', async () => {
    const res = await verdict(125, 'f5dc2591');

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await recordedSession(String((res.body as Doc).verdictId))).toBe(reviewer.sessionId);
  });

  it('refuses a start shorter than eight characters, naming the whole id it would have been', async () => {
    const res = await verdict(111, 'f5dc25');

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      '`run` f5dc25 is shorter than the 8 characters a box names a run by',
    );
    expect(refusal?.detail).toContain(reviewer.runId);
  });

  it('refuses a start two declared runs share, naming each whole id', async () => {
    const first = await declare(['ISS-200'], `7a7a7a7a-${randomUUID().slice(9)}`);
    const second = await declare(['ISS-300'], `7a7a7a7a-${randomUUID().slice(9)}`);

    const res = await verdict(200, '7a7a7a7a');

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain('begins 2 live runs this box declared on this project');
    expect(refusal?.detail).toContain(first.runId);
    expect(refusal?.detail).toContain(second.runId);

    const whole = await verdict(200, first.runId);
    expect(whole.status, JSON.stringify(whole.body)).toBeLessThan(300);
  });

  it('refuses an id that begins no declared run, naming the whole ids declared over the issue', async () => {
    const res = await verdict(111, '0b0b0b0b');

    const [refusal] = refusalsOf(res);
    expect(refusal?.code).toBe('VERDICT_RUN_UNKNOWN');
    expect(refusal?.detail).toContain(
      `the live runs this box declared over ISS-111 on this project are ${reviewer.runId}: send the one making the call, its whole id or its first 8 characters`,
    );
  });
});
