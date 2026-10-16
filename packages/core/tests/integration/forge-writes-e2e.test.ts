/**
 * ISS-1421 — what Forge's own machinery writes, it writes as Forge.
 *
 * A budget-cap notice, the weekly reading, a rescue park and a stranded release handed back are each
 * driven once against real Postgres and read back for who the row names. What an intake files is
 * held by forge-intake-e2e.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let FORGE: string;
let ownerId: string;
let projectId: string;

/** The weekly reading stores a file; `UPLOADS_DIR` defaults into the working tree. */
const uploadsDir = mkdtempSync(join(tmpdir(), 'forge-writes-uploads-'));

beforeAll(async () => {
  process.env.UPLOADS_DIR = uploadsDir;
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  FORGE = (await import('../../src/comments/forge-author.js')).FORGE_AUTHOR_ID;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
  rmSync(uploadsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
});

let seq = 0;
async function anIssue(status = 'in_progress', extra = sql``): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
  `);
  if (extra.queryChunks.length > 0) await harness.db.execute(extra);
  return id;
}

async function authorsOn(issueId: string): Promise<string[]> {
  const rows = await harness.db.execute<{ author_id: string }>(
    sql`SELECT author_id FROM comments WHERE issue_id = ${issueId} ORDER BY created_at, id`,
  );
  return rows.map((r) => r.author_id);
}

async function moversOf(
  issueId: string,
): Promise<Array<{ actor_id: string; actor_agency: string }>> {
  return harness.db.execute<{ actor_id: string; actor_agency: string }>(sql`
    SELECT actor_id, actor_agency FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} ORDER BY created_at
  `);
}

describe("Forge's notices on an issue are Forge's (ISS-1421)", () => {
  it('writes the budget-cap notice as Forge', async () => {
    const id = await anIssue();
    const { postBudgetExhaustedComment } = await import('../../src/jobs/budget-check.js');
    await postBudgetExhaustedComment({
      issueId: id,
      jobType: 'drive',
      result: { action: 'pause', spent: 12, budget: 10, stageStatus: 'in_progress' },
    });
    expect(await authorsOn(id)).toEqual([FORGE]);
  });

  it('writes the weekly reading, its files and its failure line as Forge', async () => {
    const id = await anIssue();
    const { postWeeklyComment, postWeeklyFailure } = await import(
      '../../src/assistant/weekly/post.js'
    );
    await postWeeklyComment({
      issueId: id,
      report: { body: 'the week', files: [{ name: 'week.txt', mime: 'text/plain', text: 'x' }] },
    });
    await postWeeklyFailure({ issueId: id, windowId: 'w1', error: { name: 'E', message: 'm' } });
    expect(await authorsOn(id)).toEqual([FORGE, FORGE]);
    const uploaders = await harness.db.execute<{ uploader_id: string }>(sql`
      SELECT a.uploader_id FROM comment_attachments a JOIN comments c ON c.id = a.comment_id
      WHERE c.issue_id = ${id}
    `);
    expect(uploaders.map((r) => r.uploader_id)).toEqual([FORGE]);
  });

  it('writes the rescue-cap notice as Forge', async () => {
    const id = await anIssue();
    const { postCapReachedComment } = await import(
      '../../src/pipeline/autonomous-rescue-comment.js'
    );
    await postCapReachedComment({
      issueId: id,
      fromStatus: 'in_progress',
      cap: 3,
      driveSessions: 4,
    });
    expect(await authorsOn(id)).toEqual([FORGE]);
  });
});

describe('a release nobody stopped is handed back by Forge (ISS-1421)', () => {
  it('moves and comments as Forge where no person caused the recovery', async () => {
    const run = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${run}, ${projectId}, 'system', 'cancelled', '{"source":"release-batch"}'::jsonb)
    `);
    const id = await anIssue('releasing');
    await harness.db.execute(sql`UPDATE issues SET release_batch_run_id = ${run} WHERE id = ${id}`);
    const { recoverStrandedReleasing } = await import(
      '../../src/release-batch/releasing-recovery.js'
    );

    await recoverStrandedReleasing(run, { reason: 'the run was cancelled', comment: true });

    expect(await moversOf(id)).toEqual([{ actor_id: FORGE, actor_agency: 'agent' }]);
    expect(new Set(await authorsOn(id))).toEqual(new Set([FORGE]));
  });
});
