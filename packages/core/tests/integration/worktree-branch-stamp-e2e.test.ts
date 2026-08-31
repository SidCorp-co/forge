/**
 * Core owns the issue's feature branch and hands it to the runner.
 *
 * The runner has carried a complete worktree lane since it was ported from the
 * Tauri app, and nothing ever reached it: `daemon/dispatch.rs` reads
 * `payload.worktreeBranch`, core never wrote one, so every stage of every issue
 * ran in the repo ROOT and the agent cut whatever checkout it liked. Measured
 * on dev1 2026-08-26 and recorded in `workspace/salvage.rs`: `<repo>/.worktrees/`
 * did not exist while six agent worktrees sat under `.claude/worktrees/`.
 *
 * Real Postgres, because the claim is about a COLUMN — the payload is stamped
 * at job creation so a retry resolves the same checkout, and the unit lane
 * mocks `db.insert()` into a chain that never renders the row it wrote.
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
    const project = await createTestProject(harness.db, owner.id);
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

  it('stamps worktreeBranch on a working stage so the runner cuts its own checkout', async () => {
    const s = await seed('approved');
    const { jobId } = await triggerPipelineStepManual({
      projectId: s.projectId,
      issueId: s.issueId,
      status: 'approved',
      stage: 'code',
      actor: { type: 'user', id: s.ownerId },
      reason: { trigger: 'test' },
    });

    expect(await payloadOf(jobId)).toMatchObject({
      worktreeBranch: issueBranchName(s.issSeq),
      stageStatus: 'approved',
    });
  });

  // cm:guard THIS is the assertion that keeps merging alive, and the happy-path test above cannot stand in for it. `prompt/merge-required.ts` still tells the agent to `git checkout <base>`, and git REFUSES a branch already checked out in the main worktree — so a stamp here would break the merge step on every project at once, and it would break it at the last stage of the pipeline where the cost is a whole issue's work. Drop the `!isMergeStage` condition in `pipeline/orchestrator.ts` and only this goes red.
  it('leaves a merge stage in the repo root, because a worktree cannot check out the base branch', async () => {
    const s = await seed('released');
    const { jobId } = await triggerPipelineStepManual({
      projectId: s.projectId,
      issueId: s.issueId,
      status: 'released',
      stage: 'release',
      actor: { type: 'user', id: s.ownerId },
      reason: { trigger: 'test' },
    });

    const payload = await payloadOf(jobId);
    expect(payload.stageStatus).toBe('released');
    expect(payload).not.toHaveProperty('worktreeBranch');
  });

  // cm:guard the two sides must derive the branch from ONE function. `salvage.rs#belongs_to_issue` matches a dirty worktree's branch against the `issueKey` the adapter sends, so a second spelling would make salvage refuse — "no dirty worktree matches ISS-n" — on a checkout core itself asked for, and the failed attempt's diff would be thrown away. Change the format in `issues/issue-branch.ts` alone and this stays green; change it in one CALLER and it goes red.
  it('sends the runner the same name for the checkout and for salvage', async () => {
    const s = await seed('approved');
    const { jobId } = await triggerPipelineStepManual({
      projectId: s.projectId,
      issueId: s.issueId,
      status: 'approved',
      stage: 'code',
      actor: { type: 'user', id: s.ownerId },
      reason: { trigger: 'test' },
    });

    const { claudeCodeAdapter } = await import('../../src/runners/adapters/claude-code.js');
    const { roomManager } = (await import('../../src/ws/server.js')) as unknown as {
      roomManager: { publish: ReturnType<typeof vi.fn> };
    };
    roomManager.publish.mockClear();

    const deviceId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status)
      VALUES (${deviceId}, ${s.ownerId}, 'd', 'linux', 'h', 'p', 'online')
    `);
    await claudeCodeAdapter.dispatch({
      job: {
        id: jobId,
        projectId: s.projectId,
        issueId: s.issueId,
        type: 'code',
        payload: await payloadOf(jobId),
        promptString: '',
        systemPrompt: null,
        dispatchedAt: new Date(),
        attempts: 1,
        agentSessionId: null,
      },
      runner: { id: randomUUID(), type: 'claude-code', deviceId },
    } as never);

    const frame = roomManager.publish.mock.calls[0]?.[1] as {
      data: { issueKey?: string; payload: Record<string, unknown> };
    };
    expect(frame.data.issueKey).toBe(issueBranchName(s.issSeq));
    expect(frame.data.payload.worktreeBranch).toBe(frame.data.issueKey);
  });
});
