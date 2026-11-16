/**
 * The steward's output check on a project with production, planted from forge-dev's dev.287 batch
 * (run ae4f80c3, ISS-632/634/635). The project declares `delivery.verdictsRequired: false`, so its
 * issues are judged after the release. Given no facts, the check claimed "no production
 * environment", cited a proof plan that does not exist, and reopened ISS-635 two minutes after the
 * batch claimed it; the release shipped it anyway. The steward now sends no issue back at all
 * (`steward/door-writes.ts:MOVE`, 2026-10-26): its output check reads the release facts
 * (`release-batch/steward-release-facts.ts`) and writes what is missing in its note.
 *
 * @direct-test-of packages/core/src/release-batch/steward-release-facts.ts
 * @direct-test-of packages/core/src/steward/door-writes.ts
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

describe('the steward sends nothing back at the release gate, on a project with production', () => {
  /** The steward's move refused by its field, and the issue left where it was. */
  async function refusedAndKept(issue: string, key: string) {
    const answer = await stewardReopens(issue, key);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain('to');
    expect(await statusOf(issue)).toBe('awaiting_release');
  }

  it('for a member of a live release batch, as ISS-635 was reopened two minutes after the claim', async () => {
    const issue = await atTheGate(635);
    await batchClaims([issue]);
    await refusedAndKept(issue, 'ISS-635');
  });

  it('over missing verdicts where the policy owes none at the gate', async () => {
    await judgedAfterRelease();
    await refusedAndKept(await atTheGate(634), 'ISS-634');
  });

  it('where a criterion is judged fail: the fail reopens it, by its own consumer', async () => {
    await judgedAfterRelease();
    const issue = await atTheGate(634);
    await failed(issue, 2);
    await refusedAndKept(issue, 'ISS-634');
  });

  it('where the policy owes verdicts and none is there: the note names them, a person reopens', async () => {
    await refusedAndKept(await atTheGate(632), 'ISS-632');
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
