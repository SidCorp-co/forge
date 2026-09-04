/**
 * Core owns the issue's feature branch and hands it to a runner that can use it.
 *
 * The runner has carried a complete worktree lane since it was ported from the
 * Tauri app, and nothing ever reached it: `daemon/dispatch.rs` reads
 * `payload.worktreeBranch`, core never wrote one, so every stage of every issue
 * ran in the repo ROOT and the agent cut whatever checkout it liked. Measured
 * on dev1 2026-08-26 and recorded in `workspace/salvage.rs`: `<repo>/.worktrees/`
 * did not exist while six agent worktrees sat under `.claude/worktrees/`.
 *
 * Resolved at DISPATCH, not at job creation: core deploys in one step while the
 * fleet updates on its own clock, and a runner below 0.9.3 could only ever
 * CREATE a worktree — `git worktree add` refuses an existing path, so the second
 * stage of an issue died on `fatal: already exists`. The floor is the difference
 * between reuse and a failed job.
 *
 * Real Postgres, because every input is a row: the issue's seq, the project's
 * merge states, and the device's reported build.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/ws/server.js', () => ({
  roomManager: { publish: vi.fn(() => 1) },
}));

describe('core stamps the issue feature branch onto the job payload', () => {
  let harness: TestDatabase;
  let triggerPipelineStepManual: typeof import('../../src/pipeline/orchestrator.js').triggerPipelineStepManual;
  let issueBranchName: typeof import('../../src/issues/issue-branch.js').issueBranchName;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';

    triggerPipelineStepManual = (await import('../../src/pipeline/orchestrator.js'))
      .triggerPipelineStepManual;
    issueBranchName = (await import('../../src/issues/issue-branch.js')).issueBranchName;
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed(status: string): Promise<{
    projectId: string;
    issueId: string;
    ownerId: string;
    issSeq: number;
  }> {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id, { agentConfig: {} });
    const issueId = randomUUID();
    const issSeq = Math.floor(Math.random() * 1_000_000);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${project.id}, ${issSeq}, 'Issue', ${status}, 'medium', ${owner.id})
    `);
    return { projectId: project.id, issueId, ownerId: owner.id, issSeq };
  }

  async function preparePayload(args: {
    jobId: string;
    projectId: string;
    issueId: string;
    ownerId: string;
    agentVersion: string | null;
  }): Promise<{ issueKey?: string } & Record<string, unknown>> {
    const deviceId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status, agent_version)
      VALUES (${deviceId}, ${args.ownerId}, 'd', 'linux', ${randomUUID()}, ${deviceId.slice(0, 8)}, 'online', ${args.agentVersion})
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
      VALUES (${randomUUID()}, ${args.projectId}, ${deviceId}, 'claude-code', 'wt-runner', 'online', now())
    `);
    const { prepareClaimedJob } = await import('../../src/jobs/prepare-claimed-job.js');
    const prepared = await prepareClaimedJob({ jobId: args.jobId, deviceId });
    return prepared.payload as { issueKey?: string } & Record<string, unknown>;
  }

  async function enqueue(status: string) {
    const s = await seed(status);
    const { jobId } = await triggerPipelineStepManual({
      projectId: s.projectId,
      issueId: s.issueId,
      status: status as never,
      actor: { type: 'user', id: s.ownerId, agency: 'human' },
      reason: { trigger: 'test' },
    });
    return { ...s, jobId };
  }

  it('sends the branch to a runner that can reuse a checkout', async () => {
    const s = await enqueue('open');
    const payload = await preparePayload({ ...s, agentVersion: '0.9.3' });
    expect(payload.worktreeBranch).toBe(issueBranchName(s.issSeq));
  });

  // cm:guard THIS is the assertion that stops a job from dying on a box that cannot reuse. Before 0.9.3 `worktree::create` had only a create path, so `git worktree add` hit `fatal: '.worktrees/ISS-n' already exists` on an issue's SECOND stage and the job failed before the agent started — and nothing reaps `.worktrees/` (`worktree_reap` owns `.claude/worktrees` and spares anything under 14 days), so the directory is still there every time. Lower or drop the floor in `issues/merged-at.ts` and only this goes red.
  it('sends nothing to an older runner, which could only ever create', async () => {
    const s = await enqueue('open');
    const payload = await preparePayload({ ...s, agentVersion: '0.9.2' });
    expect(payload).not.toHaveProperty('worktreeBranch');
    expect(payload.issueKey).toBe(issueBranchName(s.issSeq));
  });

  it('sends nothing to a runner whose build it cannot read', async () => {
    const s = await enqueue('open');
    const payload = await preparePayload({ ...s, agentVersion: null });
    expect(payload).not.toHaveProperty('worktreeBranch');
  });

  // cm:guard the merge-state exclusion is asserted on the PURE FUNCTION because dispatch can no longer reach it: since ISS-897 the only job type is `drive`, stamped `stageStatus:'open'`, and the merge state is `released`, so no dispatched job takes this arm. It is kept and tested because it is what would stop a merge stage being handed a worktree the day one is dispatched again — and an untested arm is one nobody notices removing.
  it('gives a merge stage nothing, because a worktree cannot check out the base branch', async () => {
    const { worktreeBranchPayload } = await import('../../src/issues/merged-at.js');

    expect(
      worktreeBranchPayload({
        status: 'released',
        agentConfig: {},
        featureBranch: 'ISS-7',
        runnerVersion: '0.9.3',
      }),
    ).toEqual({});
    expect(
      worktreeBranchPayload({
        status: 'open',
        agentConfig: {},
        featureBranch: 'ISS-7',
        runnerVersion: '0.9.3',
      }),
    ).toEqual({ worktreeBranch: 'ISS-7' });
  });

  // cm:guard the checkout and salvage must be named by ONE function. `salvage.rs#belongs_to_issue` matches a dirty worktree's branch against `issueKey`, so a second spelling would make salvage refuse — "no dirty worktree matches ISS-n" — on a checkout core itself asked for, and the failed attempt's diff would be thrown away. Change the format in `issues/issue-branch.ts` alone and this stays green; change it in one CALLER and it goes red.
  it('names the checkout and the salvage target identically', async () => {
    const s = await enqueue('open');
    const payload = await preparePayload({ ...s, agentVersion: '0.9.3' });
    expect(payload.worktreeBranch).toBe(payload.issueKey);
  });
});
