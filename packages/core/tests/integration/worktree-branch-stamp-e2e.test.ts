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

  async function payloadOf(jobId: string): Promise<Record<string, unknown>> {
    const rows = await harness.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM jobs WHERE id = ${jobId}`,
    );
    return rows[0]?.payload ?? {};
  }

  async function dispatchAndCaptureFrame(args: {
    jobId: string;
    projectId: string;
    issueId: string;
    ownerId: string;
    agentVersion: string | null;
  }): Promise<{ issueKey?: string; payload: Record<string, unknown> }> {
    const { claudeCodeAdapter } = await import('../../src/runners/adapters/claude-code.js');
    const { roomManager } = (await import('../../src/ws/server.js')) as unknown as {
      roomManager: { publish: ReturnType<typeof vi.fn> };
    };
    roomManager.publish.mockClear();
    const deviceId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status, agent_version)
      VALUES (${deviceId}, ${args.ownerId}, 'd', 'linux', ${randomUUID()}, ${deviceId.slice(0, 8)}, 'online', ${args.agentVersion})
    `);
    await claudeCodeAdapter.dispatch({
      job: {
        id: args.jobId,
        projectId: args.projectId,
        issueId: args.issueId,
        type: 'code',
        payload: await payloadOf(args.jobId),
        promptString: '',
        systemPrompt: null,
        dispatchedAt: new Date(),
        attempts: 1,
        agentSessionId: null,
      },
      runner: { id: randomUUID(), type: 'claude-code', deviceId },
    } as never);
    // cm:guard narrowed, NEVER `?.` — no call means the adapter never dispatched, and optional chaining would turn that into an `undefined` flowing into a `not.toHaveProperty('worktreeBranch')` that passes for the wrong reason. Three of the five cases here assert an ABSENCE, so a silent undefined makes exactly those unfalsifiable; `check-lint-budget` warns off `--write` on this rule for the same reason.
    const [call] = roomManager.publish.mock.calls;
    if (!call) throw new Error('the adapter published no job.assigned frame');
    return (call[1] as { data: { issueKey?: string; payload: Record<string, unknown> } }).data;
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
    const frame = await dispatchAndCaptureFrame({ ...s, agentVersion: '0.9.3' });
    expect(frame.payload.worktreeBranch).toBe(issueBranchName(s.issSeq));
  });

  // cm:guard THIS is the assertion that stops a job from dying on a box that cannot reuse. Before 0.9.3 `worktree::create` had only a create path, so `git worktree add` hit `fatal: '.worktrees/ISS-n' already exists` on an issue's SECOND stage and the job failed before the agent started — and nothing reaps `.worktrees/` (`worktree_reap` owns `.claude/worktrees` and spares anything under 14 days), so the directory is still there every time. Lower or drop the floor in `issues/merged-at.ts` and only this goes red.
  it('sends nothing to an older runner, which could only ever create', async () => {
    const s = await enqueue('open');
    const frame = await dispatchAndCaptureFrame({ ...s, agentVersion: '0.9.2' });
    expect(frame.payload).not.toHaveProperty('worktreeBranch');
    expect(frame.issueKey).toBe(issueBranchName(s.issSeq));
  });

  it('sends nothing to a runner whose build it cannot read', async () => {
    const s = await enqueue('open');
    const frame = await dispatchAndCaptureFrame({ ...s, agentVersion: null });
    expect(frame.payload).not.toHaveProperty('worktreeBranch');
  });

  // cm:guard a merge stage stays in the repo ROOT however new the runner is. `prompt/merge-required.ts` still tells the agent to `git checkout <base>`, and git REFUSES a branch already checked out in the main worktree — so stamping here breaks the merge step on every project at once, at the last stage, where the cost is a whole issue's work. Drop the merge-state exclusion in `issues/merged-at.ts` and only this goes red.
  it('leaves a merge stage in the repo root, because a worktree cannot check out the base branch', async () => {
    const s = await enqueue('open');
    const frame = await dispatchAndCaptureFrame({ ...s, agentVersion: '0.9.3' });
    expect(frame.payload.stageStatus).toBe('released');
    expect(frame.payload).not.toHaveProperty('worktreeBranch');
  });

  // cm:guard the checkout and salvage must be named by ONE function. `salvage.rs#belongs_to_issue` matches a dirty worktree's branch against `issueKey`, so a second spelling would make salvage refuse — "no dirty worktree matches ISS-n" — on a checkout core itself asked for, and the failed attempt's diff would be thrown away. Change the format in `issues/issue-branch.ts` alone and this stays green; change it in one CALLER and it goes red.
  it('names the checkout and the salvage target identically', async () => {
    const s = await enqueue('open');
    const frame = await dispatchAndCaptureFrame({ ...s, agentVersion: '0.9.3' });
    expect(frame.payload.worktreeBranch).toBe(frame.issueKey);
  });
});
