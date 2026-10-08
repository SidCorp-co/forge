/**
 * ISS-1360 — an automatic-release project holding more issues than one release carries ships them
 * in parts, and readiness says so instead of reporting a block nobody on that project can clear.
 *
 * Real Postgres, 58 waiting issues whose criteria are all earned: the oldest 50 merges are cut
 * first, the other 8 are queued behind them and cut by the next sweep once the first release has
 * handed its claims back, and readiness answers for the part the next cut carries each time.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const WAITING = 58;
const LIMIT = 50;
const FIRST_MERGE = Date.parse('2026-10-01T00:00:00Z');

describe('release in parts (ISS-1360)', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await registerIntegrationsForTest();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );

  /** A waiting issue every criterion of which a judge earned at what the project is serving. */
  async function earnedRow(mergedAt: Date | null): Promise<string> {
    const id = await fx.insertIssue();
    const block = (n: number) =>
      [
        `criterion: ${n} — ok`,
        'verdict: pass',
        `runtime: ${SERVING}`,
        'evidence: judge-evidence.txt',
        'why: exercised directly',
        'judge: judge-1',
        'judge-from: inherited',
      ].join('\n');
    const verdict = [
      '## Judged',
      '',
      '```forge-record',
      block(1),
      block(2),
      '```',
      '',
      '`forge-record: verdict · contract 1`',
    ].join('\n');
    await harness.db.execute(sql`
      UPDATE issues
         SET acceptance_criteria = ${'1. ok\n2. ok'},
             merged_at = ${mergedAt ? mergedAt.toISOString() : null}::timestamptz,
             session_context = ${JSON.stringify({ landing: { head: 'dce6f354c', deployment: SERVING } })}::jsonb
       WHERE id = ${id}
    `);
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body) VALUES (${randomUUID()}, ${id}, ${ownerId}, ${verdict})
    `);
    await harness.db.execute(sql`
      INSERT INTO issue_attachments (id, issue_id, uploader_id, name, path, mime, size)
      VALUES (${randomUUID()}, ${id}, ${ownerId}, 'judge-evidence.txt', ${`uploads/${id}`}, 'text/plain', 64)
    `);
    return id;
  }

  /** `count` marked rows merged one minute apart, inserted newest first so id order and merge order differ. */
  async function marked(count: number): Promise<string[]> {
    const byMergeOrder: string[] = new Array(count);
    for (let i = count - 1; i >= 0; i--) {
      byMergeOrder[i] = await earnedRow(new Date(FIRST_MERGE + i * 60_000));
    }
    return byMergeOrder;
  }

  async function readiness() {
    const { loadReleaseReadiness } = await import('../../src/release-batch/readiness.js');
    const read = await loadReleaseReadiness(projectId);
    if (!read) throw new Error('the project has no readiness');
    return read;
  }

  async function statusOf(id: string): Promise<{ status: string; claimed: boolean }> {
    const [row] = (await harness.db.execute(
      sql`SELECT status, release_batch_run_id IS NOT NULL AS claimed FROM issues WHERE id = ${id}`,
    )) as unknown as Array<{ status: string; claimed: boolean }>;
    if (!row) throw new Error(`no issue ${id}`);
    return row;
  }

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (
      await createTestProject(harness.db, owner.id, {
        agentConfig: { pipelineConfig: { enabled: true, autoProdDeploy: true } },
      })
    ).id;
    await fx.declareProduction();
    fx.serve(SERVING);
    await fx.seedReleaseRunner();
  });

  it('reports the oldest fifty as the part and the rest as what is left, and no block', async () => {
    await earnedRow(null);
    await marked(WAITING - 1);

    const read = await readiness();

    // The unmarked row is last in the order, so it is behind the part: had it been judged here it
    // would have been refused for the landing it never recorded.
    expect(read.blockers.map((b) => b.code)).toEqual([]);
    const parted = read.warnings.find((w) => w.code === 'RELEASE_ROSTER_IN_PARTS');
    expect(parted?.details).toEqual({
      waiting: WAITING,
      limit: LIMIT,
      part: LIMIT,
      later: WAITING - LIMIT,
    });
  }, 120_000);

  it('cuts the oldest fifty, queues the other eight, and cuts them on the next sweep', async () => {
    const byMerge = await marked(WAITING);
    const { sweepAutomaticReleases } = await import('../../src/pipeline/release-sweep.js');

    const first = await sweepAutomaticReleases();

    expect(first.issuesCut).toBe(LIMIT);
    for (const id of byMerge.slice(0, LIMIT)) {
      expect(await statusOf(id)).toEqual({ status: 'releasing', claimed: true });
    }
    for (const id of byMerge.slice(LIMIT)) {
      expect(await statusOf(id)).toEqual({ status: 'awaiting_release', claimed: false });
      expect((await fx.holdOf(id))?.code).toBe('RELEASE_QUEUED_BEHIND');
    }

    // Readiness while that release runs: the eight are the next part, and the release is the block.
    const during = await readiness();
    expect(during.blockers.map((b) => b.code)).toEqual(['BATCH_IN_FLIGHT']);
    expect(during.warnings.map((w) => w.code)).not.toContain('RELEASE_ROSTER_IN_PARTS');

    // The first release finishes and hands its claims back.
    await harness.db.execute(sql`
      UPDATE issues SET status = 'closed', release_batch_run_id = NULL
       WHERE id IN (${sql.join(
         byMerge.slice(0, LIMIT).map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'completed', finished_at = now(), exit_code = 0
       WHERE project_id = ${projectId} AND type = 'release_batch'
    `);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'completed'
       WHERE project_id = ${projectId} AND (metadata->>'source') = 'release-batch'
    `);

    const second = await sweepAutomaticReleases();

    expect(second.issuesCut).toBe(WAITING - LIMIT);
    for (const id of byMerge.slice(LIMIT)) {
      expect(await statusOf(id)).toEqual({ status: 'releasing', claimed: true });
    }
  }, 180_000);

  it('still refuses 51 waiting issues by size where a person cuts the release', async () => {
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = '{"pipelineConfig":{"enabled":true}}'::jsonb WHERE id = ${projectId}
    `);
    await marked(LIMIT + 1);

    const read = await readiness();

    const over = read.blockers.find((b) => b.code === 'RELEASE_ROSTER_OVERSIZE');
    expect(over?.details).toEqual({ waiting: LIMIT + 1, limit: LIMIT });
    expect(read.warnings.map((w) => w.code)).not.toContain('RELEASE_ROSTER_IN_PARTS');
  }, 120_000);
});
