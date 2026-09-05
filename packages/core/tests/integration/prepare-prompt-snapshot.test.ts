/**
 * ISS-186 — prompt-snapshot write path E2E.
 *
 * Drives the real `prepareClaimedJob` against real Postgres to
 * verify that the dispatcher populates the 6 prompt-snapshot columns on
 * `jobs` (added by migration 0068) and UPSERTs into `prompt_blobs` with an
 * atomic `ref_count` increment so two dispatches for the same project
 * dedupe to a single blob row.
 *
 * ISS-267: the legacy device path was removed; the suite now seeds an online
 * `claude-code` runner so the candidate query resolves it. The snapshot
 * helper is invoked identically regardless of dispatch path.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  prepareClaimedJob: typeof import('../../src/jobs/prepare-claimed-job.js').prepareClaimedJob;
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

    const prepareMod = await import('../../src/jobs/prepare-claimed-job.js');
    mods = { prepareClaimedJob: prepareMod.prepareClaimedJob };
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
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`);
    // cm:guard the runner row must be bound to THIS device — `prepareClaimedJob` resolves the runner by (project, device) and refuses by name when the pair is missing.
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${project.id}, 'claude-code', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, ${'{"pm": true}'}::jsonb, 'online', now()
      )
    `);
    return { owner, project, device, runnerId };
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

  it('populates all snapshot columns on the jobs row after preparation', async () => {
    const { owner, project, device } = await seedRunner();
    const issueId = await insertIssue(project.id, owner.id);
    const jobId = await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      promptString: '/forge-triage iss-1',
    });

    await mods.prepareClaimedJob({ jobId, deviceId: device.id });

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
    if (!row) throw new Error('unreachable: asserted above');
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
    // cm:why the floor is 2 rather than 3 — project-config is only emitted when the project HAS one, so pinning 3 makes this test a function of fixture config rather than of the preamble builder.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).toHaveProperty('id');
      expect(block.kind).toBe('system');
      expect(typeof block.chars).toBe('number');
      expect(typeof block.estTokens).toBe('number');
    }
  });

  it('dedupes prompt_blobs across same-project preparations with atomic ref_count', async () => {
    const { owner, project, device } = await seedRunner();
    const issueA = await insertIssue(project.id, owner.id);
    const issueB = await insertIssue(project.id, owner.id);
    const jobA = await insertJob({ projectId: project.id, issueId: issueA, ownerId: owner.id });
    const jobB = await insertJob({ projectId: project.id, issueId: issueB, ownerId: owner.id });

    await mods.prepareClaimedJob({ jobId: jobA, deviceId: device.id });
    await mods.prepareClaimedJob({ jobId: jobB, deviceId: device.id });

    const blobs = await harness.db.execute<{ hash: string; ref_count: number }>(sql`
      SELECT hash, ref_count FROM prompt_blobs
    `);
    expect(blobs).toHaveLength(1);
    const blob = blobs[0];
    if (!blob) throw new Error('unreachable: asserted above');
    expect(Number(blob.ref_count)).toBe(2);

    const jobRows = await harness.db.execute<{ system_prompt_hash: string }>(sql`
      SELECT system_prompt_hash FROM jobs WHERE id IN (${jobA}, ${jobB})
    `);
    expect(jobRows).toHaveLength(2);
    const [first, second] = jobRows;
    if (!first || !second) throw new Error('unreachable: asserted above');
    expect(first.system_prompt_hash).toBe(second.system_prompt_hash);
    expect(first.system_prompt_hash).toBe(blob.hash);
  });

  it('writes empty-string userPromptSnapshot when payload omits promptString', async () => {
    const { owner, project, device } = await seedRunner();
    const issueId = await insertIssue(project.id, owner.id);
    const jobId = await insertJob({ projectId: project.id, issueId, ownerId: owner.id });

    await mods.prepareClaimedJob({ jobId, deviceId: device.id });

    const rows = await harness.db.execute<{ user_prompt_snapshot: string | null }>(sql`
      SELECT user_prompt_snapshot FROM jobs WHERE id = ${jobId}
    `);
    expect(rows[0]?.user_prompt_snapshot).toBe('');
  });
});
