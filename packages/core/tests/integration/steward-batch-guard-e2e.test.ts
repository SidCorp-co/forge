/**
 * The steward's output check on a project with production, planted from forge-dev's dev.287 batch
 * (run ae4f80c3, ISS-632/634/635). The project declares `delivery.verdictsRequired: false`, so its
 * issues are judged after the release. Given no facts, the check claimed "no production
 * environment", cited a proof plan that does not exist, and reopened ISS-635 two minutes after the
 * batch claimed it; the release shipped it anyway. Then the three post-release judges were skipped
 * `budget_spent` and left nothing on the issues. Each refusal is kernel input, read at the steward's
 * own move door (`release-batch/reopen-guard.ts`), whatever the model concluded.
 *
 * @direct-test-of packages/core/src/release-batch/reopen-guard.ts
 * @direct-test-of packages/core/src/steward/dispatch.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProduction } from '../helpers/release-world.js';

let projectId = '';
let ownerId = '';
let token = '';

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  await seedProduction({ projectId, ownerId, probes: 'none', name: 'forge-dev' });
});

/** forge-dev's own policy: its issues owe no verdict at the gate; QA judges the shipped build. */
const judgedAfterRelease = () =>
  db.execute(sql`
    UPDATE project_config_documents
       SET document = jsonb_set(document, '{delivery}', '{"verdictsRequired": false}'::jsonb)
     WHERE project_id = ${projectId}`);

/** ISS-`seq` at awaiting_release with three criteria and no verdict. */
async function atTheGate(seq: number): Promise<string> {
  const issue = await createTestIssue(projectId, ownerId, seq, {
    status: 'in_progress',
    createdAt: new Date(),
    mergedAt: new Date(),
  });
  await replaceCriteria(issue.id, [
    { n: 1, statement: 'Every answer is pressable above the tab bar' },
    { n: 2, statement: 'The panel says each thing once' },
    { n: 3, statement: 'The counts agree' },
  ]);
  await seedIssueStatus(issue.id, 'awaiting_release');
  return issue.id;
}

/** A release batch, still running unless `status` says it ended, that claims `issueIds`. */
async function batchClaims(issueIds: readonly string[], status = 'running'): Promise<string> {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, metadata)
    VALUES (${runId}, ${projectId}, 'system', ${status}, now(),
            ${JSON.stringify({ source: 'release-batch', issueIds })}::jsonb)`);
  for (const id of issueIds) {
    await db.execute(sql`UPDATE issues SET release_batch_run_id = ${runId} WHERE id = ${id}`);
  }
  return runId;
}

async function failed(issueId: string, n: number) {
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                    author_user_id, author_agency, judge)
    SELECT c.id, ${issueId}, 'fail', 'The counts disagree on the live page.', 'commit', ${'a'.repeat(40)},
           ${ownerId}, 'agent', 'qa'
      FROM issue_criteria c WHERE c.issue_id = ${issueId} AND c.n = ${n} AND c.retired_at IS NULL`);
}

const statusOf = async (issueId: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${issueId}`))[0]?.status;

async function stewardReopens(issueId: string, issueKey: string) {
  const { callStewardDoor } = await import('../../src/steward/doors.js');
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, started_at)
    VALUES (${projectId}, 'issue', ${issueId}, ${issueKey}, 'release.asked', '[]'::jsonb,
            ARRAY['output_check']::text[], 'running', now(), now())
    RETURNING id`);
  const ctx = {
    projectId,
    runId: run?.id ?? '',
    act: 'output_check' as const,
    subject: { kind: 'issue', id: issueId, key: issueKey },
    standing: null,
    token,
    refused: [] as string[],
    broken: [] as string[],
    acts: [] as string[],
  };
  return callStewardDoor(
    'steward_move_issue',
    JSON.stringify({
      issue: issueKey,
      to: 'reopen',
      reason:
        'BC-13 and BC-14 have no counting verdict on the running build, and the release record gives no proof that it will run their checks.',
    }),
    ctx,
  );
}

describe("the steward's reopen at the release gate, on a project with production", () => {
  it('is refused for a member of a live release batch, as ISS-635 was not', async () => {
    const issue = await atTheGate(635);
    const run = await batchClaims([issue]);

    const answer = await stewardReopens(issue, 'ISS-635');

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_RELEASING');
    expect(answer.text).toContain(
      `ISS-635 is a member of release batch ${run}, which is still running`,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('is refused over missing verdicts where the policy owes none at the gate', async () => {
    await judgedAfterRelease();
    const issue = await atTheGate(634);

    const answer = await stewardReopens(issue, 'ISS-634');

    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_JUDGED_AFTER_RELEASE');
    expect(answer.text).toContain('delivery.verdictsRequired: false');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('still sends it back where the policy owes none but a criterion is judged fail', async () => {
    await judgedAfterRelease();
    const issue = await atTheGate(634);
    await failed(issue, 2);

    const answer = await stewardReopens(issue, 'ISS-634');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('still sends it back where the policy owes verdicts and none is there, as before', async () => {
    const issue = await atTheGate(632);

    const answer = await stewardReopens(issue, 'ISS-632');

    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });
});

describe('what the output check is told of the release', () => {
  it('names the production environment, the delivery policy and the batch claim', async () => {
    await judgedAfterRelease();
    const issue = await atTheGate(632);
    const run = await batchClaims([issue]);
    const { stewardReleaseFacts } = await import('../../src/release-batch/index.js');

    const facts = await stewardReleaseFacts(projectId, issue);

    expect(facts).toContain('This project has a production environment, `forge-dev`');
    expect(facts).not.toContain('no production environment');
    expect(facts).toContain('delivery.verdictsRequired: false');
    expect(facts).toContain(`member of release batch ${run}, still running`);
  });
});

describe('the judge a release owes, where the day cannot pay for it', () => {
  it('waits for the next day, queued, and says so on the issue, where dev.287 skipped it silently', async () => {
    await db.execute(sql`
      UPDATE project_config_documents
         SET document = jsonb_set(document, '{steward}', '{"budget": {"runnerJobs": 0}}'::jsonb)
       WHERE project_id = ${projectId}`);
    const issue = await createTestIssue(projectId, ownerId, 635, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    const [queued] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, queued_at, not_before)
      VALUES (${projectId}, 'issue', ${issue.id}, 'ISS-635', 'release.shipped', '[]'::jsonb,
              ARRAY['release_followthrough']::text[], 'queued', now() - interval '3 minutes',
              now() - interval '1 minute')
      RETURNING id`);
    const { dispatchStewardRuns } = await import('../../src/steward/dispatch.js');
    const now = new Date();

    await dispatchStewardRuns(now);

    const [run] = await rows<{ state: string; skip_reason: string | null; not_before: string }>(sql`
      SELECT state, skip_reason, not_before::text FROM steward_runs WHERE id = ${queued?.id}`);
    expect(run?.skip_reason ?? null).toBeNull();
    expect(run?.state).toBe('queued');
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(new Date(run?.not_before ?? 0).getTime()).toBe(midnight);
    const comments = await rows<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${issue.id}`);
    expect(comments.map((c) => c.body).join('\n')).toContain(
      'The judge this release owes ISS-635 has not run yet',
    );
  });
});

describe('the runner jobs kept for release follow-throughs (4 of the default 10)', () => {
  /** A claimed run of `act` on a fresh subject, as dispatch hands it to the cost guard. */
  async function claimed(kind: string, key: string, trigger: string, act: string) {
    const [made] = await rows<{ id: string }>(sql`
      INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                                acts_to_run, state, not_before)
      VALUES (${projectId}, ${kind}, ${randomUUID()}, ${key}, ${trigger}, '[]'::jsonb,
              ARRAY[${act}]::text[], 'running', now())
      RETURNING id`);
    return { id: made?.id ?? '', projectId, trigger };
  }

  // 2026-10-22's shape: feedback triages take the runner jobs up from the small hours, and the
  // release that ships at 18:44 finds none left for its three judges
  it('lets three follow-throughs run after ten handoff triages asked for the whole day', async () => {
    const { admitRun } = await import('../../src/steward/policy.js');
    const now = new Date();
    const triaged: (string | null)[] = [];
    for (let n = 0; n < 10; n += 1) {
      const run = await claimed('feedback', `FB-${180 + n}`, 'feedback.filed', 'triage_draft');
      triaged.push(await admitRun(run, ['triage_draft'], now));
    }
    const judged: (string | null)[] = [];
    for (const key of ['ISS-632', 'ISS-634', 'ISS-635']) {
      const run = await claimed('issue', key, 'release.shipped', 'release_followthrough');
      judged.push(await admitRun(run, ['release_followthrough'], now));
    }

    expect(judged).toEqual([null, null, null]);
    expect(triaged.filter((r) => r === null)).toHaveLength(6);
    expect(triaged.slice(6)).toEqual([
      'budget_spent',
      'budget_spent',
      'budget_spent',
      'budget_spent',
    ]);
  });

  it('keeps ceil(40%) of a lowered cap: 2 of 3', async () => {
    await db.execute(sql`
      UPDATE project_config_documents
         SET document = jsonb_set(document, '{steward}', '{"budget": {"runnerJobs": 3}}'::jsonb)
       WHERE project_id = ${projectId}`);
    const { admitRun } = await import('../../src/steward/policy.js');
    const now = new Date();
    const first = await claimed('feedback', 'FB-1', 'feedback.filed', 'triage_draft');
    const second = await claimed('feedback', 'FB-2', 'feedback.filed', 'triage_draft');

    expect(await admitRun(first, ['triage_draft'], now)).toBeNull();
    expect(await admitRun(second, ['triage_draft'], now)).toBe('budget_spent');
  });
});

describe('the kernel refuses any reopen of a running release batch member (ISSUE_REOPEN_RELEASING)', () => {
  const row = async (issueId: string) => {
    const [r] = await rows<{
      id: string;
      project_id: string;
      status: string;
      reopen_count: number;
    }>(sql`SELECT id, project_id, status, reopen_count FROM issues WHERE id = ${issueId}`);
    return {
      id: r?.id ?? '',
      projectId: r?.project_id ?? '',
      status: r?.status as 'awaiting_release',
      reopenCount: Number(r?.reopen_count ?? 0),
    };
  };
  const named = (run: string) =>
    `release 0.4.0-dev.287 (batch ${run}) is still running and claims this issue`;
  const versioned = (run: string) =>
    db.execute(sql`UPDATE pipeline_runs SET release_version = '0.4.0-dev.287' WHERE id = ${run}`);

  it("refuses a person's reopen through the transition door, naming the batch and its version", async () => {
    const issue = await atTheGate(635);
    const run = await batchClaims([issue]);
    await versioned(run);

    const res = await api(token, 'POST', `/api/issues/${issue}/transition`, {
      toStatus: 'reopen',
      reason: 'The panel repeats itself on a phone.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain('ISSUE_REOPEN_RELEASING');
    expect(JSON.stringify(res.body)).toContain(named(run));
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it("refuses a box's reopen, and one that hands the release's run id in its own options", async () => {
    const issue = await atTheGate(634);
    const run = await batchClaims([issue]);
    await versioned(run);
    const { transitionIssueStatus } = await import('../../src/issues/index.js');
    const box = { type: 'device' as const, id: randomUUID(), ownerId };
    const smuggled = { transitionReason: 'Sent back by a box.', releaseReplayRunId: run };

    await expect(transitionIssueStatus(await row(issue), 'reopen', box, smuggled)).rejects.toThrow(
      /ISSUE_REOPEN_RELEASING/,
    );
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it("lets the claiming release's own replay send it back, and no other release's", async () => {
    const issue = await atTheGate(632);
    const run = await batchClaims([issue]);
    const { reopenAsItsRelease } = await import('../../src/issues/index.js');
    const actor = { type: 'user' as const, id: ownerId, agency: 'agent' as const };
    const reason = { transitionReason: 'The kept probe failed on the served build.' };

    await expect(reopenAsItsRelease(await row(issue), randomUUID(), actor, reason)).rejects.toThrow(
      /ISSUE_REOPEN_RELEASING/,
    );
    await reopenAsItsRelease(await row(issue), run, actor, reason);

    expect(await statusOf(issue)).toBe('reopen');
  });

  it('allows a reopen again once the batch has finished', async () => {
    const issue = await atTheGate(635);
    await batchClaims([issue], 'completed');

    const res = await api(token, 'POST', `/api/issues/${issue}/transition`, {
      toStatus: 'reopen',
      reason: 'The panel repeats itself on a phone.',
    });

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(await statusOf(issue)).toBe('reopen');
  });
});
