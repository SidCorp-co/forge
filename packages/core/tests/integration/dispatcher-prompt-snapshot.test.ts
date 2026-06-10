/**
 * ISS-186 — prompt-snapshot write path E2E.
 *
 * Drives the real `handleDispatch` runner path against real Postgres to
 * verify that the dispatcher populates the 6 prompt-snapshot columns on
 * `jobs` (added by migration 0068) and UPSERTs into `prompt_blobs` with an
 * atomic `ref_count` increment so two dispatches for the same project
 * dedupe to a single blob row.
 *
 * ISS-267: the legacy device path was removed; the suite now seeds an online
 * `claude-code` runner so `selectRunnerForJob` resolves it. The snapshot
 * helper is invoked identically regardless of dispatch path.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
};

describe('ISS-186 prompt-snapshot write path', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    const { bootstrapRunnerAdapters } = await import('../../src/runners/bootstrap.js');
    // Register adapters so `getRunnerAdapter('claude-code')` resolves on the
    // dispatch path. Idempotent.
    bootstrapRunnerAdapters();
    mods = { handleDispatch: dispatcherMod.handleDispatch };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedRunner() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    // dispatcher requires fresh lastSeenAt within DISPATCH_LIVENESS_MS.
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`);
    // Online claude-code runner bound to the device so `selectRunnerForJob`
    // resolves it via the standby step (no defaultDeviceId pin needed).
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${project.id}, 'claude-code', 'device', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, ${'{"pm": true}'}::jsonb, 'online', now()
      )
    `);
    return { owner, project, device, runnerId };
  }

  // Runner cap is 1 in-flight; mark a dispatched job terminal so a second
  // dispatch to the same runner isn't blocked by the runner_full barrier.
  async function markJobDone(jobId: string) {
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${jobId}
    `);
  }

  async function insertIssue(projectId: string, ownerId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', 'medium', ${ownerId}
      )
    `);
    return id;
  }

  async function insertPipelineRun(projectId: string, issueId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
    return id;
  }

  async function insertJob(args: {
    projectId: string;
    issueId: string;
    ownerId: string;
    promptString?: string;
  }): Promise<string> {
    const id = randomUUID();
    const payload = args.promptString ? JSON.stringify({ promptString: args.promptString }) : '{}';
    const pipelineRunId = await insertPipelineRun(args.projectId, args.issueId);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, pipeline_run_id, created_by)
      VALUES (
        ${id}, ${args.projectId}, ${args.issueId}, 'triage', 'queued', ${payload}::jsonb, ${pipelineRunId}, ${args.ownerId}
      )
    `);
    return id;
  }

  it('populates all snapshot columns on the jobs row after dispatch', async () => {
    const { owner, project } = await seedRunner();
    const issueId = await insertIssue(project.id, owner.id);
    const jobId = await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      promptString: '/forge-triage iss-1',
    });

    const result = await mods.handleDispatch({ jobId });
    expect(result).toBe('dispatched');

    const rows = await harness.db.execute<{
      system_prompt_hash: string | null;
      user_prompt_snapshot: string | null;
      prompt_input_token_est: number | null;
      model_used: string | null;
      prompt_blocks: unknown;
    }>(sql`
      SELECT system_prompt_hash, user_prompt_snapshot, prompt_input_token_est, model_used, prompt_blocks
      FROM jobs WHERE id = ${jobId}
    `);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row.system_prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.user_prompt_snapshot).toBe('/forge-triage iss-1');
    expect(typeof row.prompt_input_token_est).toBe('number');
    expect(row.prompt_input_token_est ?? 0).toBeGreaterThan(0);
    expect(row.model_used).toBe('default');
    expect(Array.isArray(row.prompt_blocks)).toBe(true);
    const blocks = row.prompt_blocks as Array<{
      id: string;
      kind: string;
      chars: number;
      estTokens: number;
    }>;
    // pipeline-rules + tool-reference + project-config = 3 blocks.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toHaveProperty('id');
      expect(block.kind).toBe('system');
      expect(typeof block.chars).toBe('number');
      expect(typeof block.estTokens).toBe('number');
    }
  });

  it('dedupes prompt_blobs across same-project dispatches with atomic ref_count', async () => {
    const { owner, project } = await seedRunner();
    const issueA = await insertIssue(project.id, owner.id);
    const issueB = await insertIssue(project.id, owner.id);
    const jobA = await insertJob({ projectId: project.id, issueId: issueA, ownerId: owner.id });
    const jobB = await insertJob({ projectId: project.id, issueId: issueB, ownerId: owner.id });

    expect(await mods.handleDispatch({ jobId: jobA })).toBe('dispatched');
    // Free the single runner's in-flight slot before the second dispatch.
    await markJobDone(jobA);
    expect(await mods.handleDispatch({ jobId: jobB })).toBe('dispatched');

    const blobs = await harness.db.execute<{ hash: string; ref_count: number }>(sql`
      SELECT hash, ref_count FROM prompt_blobs
    `);
    expect(blobs).toHaveLength(1);
    expect(Number(blobs[0].ref_count)).toBe(2);

    const jobRows = await harness.db.execute<{ system_prompt_hash: string }>(sql`
      SELECT system_prompt_hash FROM jobs WHERE id IN (${jobA}, ${jobB})
    `);
    expect(jobRows[0].system_prompt_hash).toBe(jobRows[1].system_prompt_hash);
    expect(jobRows[0].system_prompt_hash).toBe(blobs[0].hash);
  });

  it('writes empty-string userPromptSnapshot when payload omits promptString', async () => {
    const { owner, project } = await seedRunner();
    const issueId = await insertIssue(project.id, owner.id);
    const jobId = await insertJob({ projectId: project.id, issueId, ownerId: owner.id });

    expect(await mods.handleDispatch({ jobId })).toBe('dispatched');

    const rows = await harness.db.execute<{ user_prompt_snapshot: string | null }>(sql`
      SELECT user_prompt_snapshot FROM jobs WHERE id = ${jobId}
    `);
    expect(rows[0].user_prompt_snapshot).toBe('');
  });
});
