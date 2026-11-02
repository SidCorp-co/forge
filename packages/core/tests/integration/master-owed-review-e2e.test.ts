/**
 * ISS-870 (FB-433): on a strict project, whose gate profile declares an independent judge, an issue
 * owing only that judge's review is master work. Planted: an outdated master pane on a project whose
 * one issue stands at `in_progress` on its test step with a criterion nobody but its builder could
 * have judged. Before the fix the sweep read nothing owed, so the pane was kept draining and no
 * successor was placed ("a successor would have nothing"); now it is replaced and its nudge names the
 * review. Under standard and yolo, where no independent judge is declared, nothing is owed, and once
 * the judge's pass is recorded nothing is owed either.
 *
 * @direct-test-of packages/core/src/masters/owed.ts
 * @direct-test-of packages/core/src/masters/owed-reviews.ts
 * @direct-test-of packages/core/src/issues/reviews-owed.ts
 * @direct-test-of packages/core/src/masters/verdict.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestIssue,
  createTestUser,
} from '../helpers/factories.js';
import { projectBuiltFrom } from '../helpers/pattern-world.js';

type Who = 'owner' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let ownerId = '';
let projectId = '';
let runnerId = '';
let testIssue = { id: '', key: '' };
let releaseIssue = { id: '', key: '' };

/** A live criterion `n` on `issueId`, judged by nobody yet. */
async function criterion(issueId: string, n: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position)
    VALUES (${issueId}, ${n}, ${`criterion ${n} holds`}, ${n - 1})`);
}

/** A pass on criterion `n` by a person who built nothing on the issue: the independent judge's. */
async function judgedPass(issueId: string, n: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT c.id, ${issueId}, 'pass', 'judged on the running build', 'commit',
           ${'a'.repeat(40)}, ${ownerId}, 'human', 'qa'
      FROM issue_criteria c WHERE c.issue_id = ${issueId} AND c.n = ${n} AND c.retired_at IS NULL`);
}

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = await projectBuiltFrom(ownerId, 'github.com/acme/owed-review');
  await addProjectMember(projectId, ownerId, 'owner');
  const deviceId = await createTestDevice(ownerId);
  runnerId = await bindTestRunner(projectId, deviceId);
  say = requester(app, {
    owner: await signUserToken(ownerId),
    box: (
      await mintPat({
        permissions: ['*'],
        userId: ownerId,
        name: 'box',
        deviceId,
        projectIds: [projectId],
      })
    ).plaintext,
  }) as typeof say;
  ok(
    await say('box', 'POST', '/api/devices/me/master-session', {
      projectId,
      name: 'forge-master-owed-review',
      maxJobPanes: 1,
    }),
  );
  // the one issue: built, at its test step, nothing holding it, its criterion owed its judge
  testIssue = await createTestIssue(projectId, ownerId, 1, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, step, step_started_at)
    VALUES (${testIssue.id}, 'test', now())`);
  await criterion(testIssue.id, 1);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

async function profile(name: 'standard' | 'yolo' | 'strict'): Promise<void> {
  const read = ok(await say('owner', 'GET', `/api/projects/${projectId}/gates`));
  ok(
    await say('owner', 'PUT', `/api/projects/${projectId}/gates`, {
      baseRevision: read.revision,
      profile: name,
      overrides: {},
      reason: `planted: ${name} for the owed review test`,
    }),
  );
}

/** An alive master pane placed with a skill the box would no longer hand it, holding nothing. */
function outdatedFacts(): Doc {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'alive',
    capability: 'current',
    serversReadable: true,
    work: { poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-870', transcript: 'present', elsewhere: 'none' },
    placement: {
      placed: { skill: '400bf1e38ab6' },
      unreadable: null,
      now: { skill: 'cd72790b1905' },
    },
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: null,
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { last: null, since: 'unreported' },
  };
}

const verdict = async (): Promise<Doc> =>
  ok(
    await say('box', 'POST', '/api/devices/me/master-session/verdict', {
      projectId,
      runnerId,
      facts: outdatedFacts(),
    }),
  );

describe('ISS-870: a review owed to an independent judge is master work', () => {
  it('strict: an outdated master owing only a review is replaced, its nudge naming the review', async () => {
    await profile('strict');
    const answer = await verdict();
    expect(answer.work).toMatchObject({ admissible: 0, owed: 1 });
    expect(answer.verdict).toMatchObject({ act: 'replace', reason: 'outdated', nudge: true });
    expect(String(answer.work.nudge)).toContain(
      `1 issue owes an independent review (${testIssue.key} ${testIssue.id} at \`in_progress\`, its test step, criterion 1)`,
    );
  });

  it('standard and yolo declare no independent judge, so the same pane is kept draining as before', async () => {
    for (const name of ['standard', 'yolo'] as const) {
      await profile(name);
      const answer = await verdict();
      expect(answer.work, name).toMatchObject({ admissible: 0, owed: 0 });
      expect(answer.verdict, name).toMatchObject({ act: 'keep', drain: true });
      expect(String(answer.work.nudge), name).not.toContain('independent review');
    }
  });

  it('strict: an issue at the release gate owes its review until the judge records it', async () => {
    await profile('strict');
    releaseIssue = await createTestIssue(projectId, ownerId, 2, {
      status: 'awaiting_release',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await criterion(releaseIssue.id, 1);
    await criterion(releaseIssue.id, 2);
    await judgedPass(releaseIssue.id, 1);
    const nudge = String((await verdict()).work.nudge);
    expect(nudge).toContain(
      `${releaseIssue.key} ${releaseIssue.id} at \`awaiting_release\`, criterion 2`,
    );
  });

  it('strict: once the judge recorded every criterion, no review is owed and nothing places a successor', async () => {
    await profile('strict');
    await judgedPass(testIssue.id, 1);
    await judgedPass(releaseIssue.id, 2);
    // the release gate's own ask, its note, is not this test's: the issue carries one that reads right
    await db.execute(sql`
      UPDATE issues SET release_notes = ${JSON.stringify({
        section: 'Fixed',
        title: 'Inbox order',
        userFacing: 'Your inbox sorts by date again.',
      })}::jsonb
       WHERE id = ${releaseIssue.id}`);
    const answer = await verdict();
    expect(answer.work).toMatchObject({ admissible: 0, owed: 0 });
    expect(answer.verdict).toMatchObject({ act: 'keep', drain: true });
    expect(String(answer.work.nudge)).not.toContain('independent review');
  });

  it("strict: a builder's own pass does not discharge the review", async () => {
    await profile('strict');
    const built = await createTestIssue(projectId, ownerId, 3, {
      status: 'in_progress',
      createdAt: new Date(),
    });
    await db.execute(sql`
      INSERT INTO issue_work_state (issue_id, step, step_started_at)
      VALUES (${built.id}, 'test', now())`);
    await criterion(built.id, 1);
    // the builder recorded a check on the issue, then its own pass: kept as evidence, never counted
    await db.execute(sql`
      INSERT INTO issue_check_runs (id, issue_id, kind, name, scope, command, result, duration_ms,
                                    started_at, head_sha, via, recorded_by)
      VALUES (${randomUUID()}, ${built.id}, 'tests', 'unit', 'core', 'pnpm test', 'pass', 1,
              now(), ${'b'.repeat(40)}, 'report', ${ownerId})`);
    await judgedPass(built.id, 1);
    const answer = await verdict();
    expect(answer.work).toMatchObject({ owed: 1 });
    expect(String(answer.work.nudge)).toContain(`${built.key} ${built.id} at \`in_progress\``);
  });
});
