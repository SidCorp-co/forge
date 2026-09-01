/**
 * ISS-887 — `resumeContinuity` runs its aggregation IN POSTGRES, and the unit test around it
 * cannot see that. `db.execute` is mocked there, so the JSON path, the `IS NOT NULL` predicate and
 * the `GROUP BY` had never executed anywhere: review inverted the predicate — counting attempt 1
 * and excluding every real offer, which is the exact opposite of the issue's second constraint —
 * and all 16 unit tests stayed green. A green that survives its own rule being inverted is not
 * evidence of anything.
 *
 * So this drives the real report builder against a real database, over rows shaped the way
 * `ensureAgentSessionForJob` writes them, and asserts the three things only Postgres can answer:
 * that an attempt with no prior session is outside the denominator, that a dropped one is inside
 * it and named, and that a healthy dispatch is counted rather than filtered away with the failures.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-887 resumeContinuity over real Postgres', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  let buildReport: typeof import('../../src/metrics/session-failures-report.js').buildSessionFailuresReport;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    const report = await import('../../src/metrics/session-failures-report.js');
    buildReport = report.buildSessionFailuresReport;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    ownerId = user.id;
    const project = await createTestProject(harness.db, ownerId);
    projectId = project.id;
  });

  /** `agent_sessions.pipeline_run_id` is NOT NULL, so every attempt needs a run to hang from. */
  async function insertRun(forProject: string): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${forProject}, ${null}, 'system', 'completed', now())
    `);
    return runId;
  }

  /** One attempt's row, carrying the `metadata.resume` record the dispatcher stamps. */
  async function seedAttempt(
    resume: {
      resumed: boolean;
      dropReason: string | null;
      priorClaudeSessionId: string | null;
    },
    opts: { status?: string } = {},
  ): Promise<void> {
    const runId = await insertRun(projectId);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata, created_at, updated_at)
      VALUES (
        ${randomUUID()}, ${projectId}, ${runId}, ${opts.status ?? 'completed'},
        ${JSON.stringify({
          type: 'pipeline',
          resume: {
            ...resume,
            priorDeviceId: null,
            pinDeviceId: null,
            failureAction: null,
          },
        })}::jsonb,
        now(), now()
      )
    `);
  }

  // cm:guard reads the SERVICE, not the MCP tool it used to go through — `buildSessionFailuresReport` is where the rule lives since ISS-894, and the tool and `GET /api/projects/:id/metrics/session-failures` are both thin callers of it. Asserting through a transport would make this test fail for reasons that have nothing to do with resume continuity, and would have died with the tool.
  async function readContinuity() {
    return (await buildReport(projectId, 30)).resumeContinuity;
  }

  it('leaves attempt 1 outside the denominator — it had nothing to continue', async () => {
    await seedAttempt({ resumed: false, dropReason: null, priorClaudeSessionId: null });
    await seedAttempt({ resumed: false, dropReason: null, priorClaudeSessionId: null });
    const out = await readContinuity();
    expect(out.offered).toBe(0);
    expect(out.dropped).toBe(0);
    expect(out.dropRate).toBe(0);
  });

  it('counts an offered-and-dropped attempt, and names the reason', async () => {
    await seedAttempt({ resumed: false, dropReason: null, priorClaudeSessionId: null });
    await seedAttempt({ resumed: false, dropReason: 'pin_stale', priorClaudeSessionId: 'cli-1' });
    await seedAttempt({
      resumed: false,
      dropReason: 'failure_action',
      priorClaudeSessionId: 'cli-2',
    });
    await seedAttempt({ resumed: true, dropReason: null, priorClaudeSessionId: 'cli-3' });
    const out = await readContinuity();
    expect(out.offered).toBe(3);
    expect(out.resumed).toBe(1);
    expect(out.dropped).toBe(2);
    expect(out.rows).toEqual([
      { reason: 'failure_action', sessions: 1 },
      { reason: 'pin_stale', sessions: 1 },
    ]);
  });

  it('counts a drop on a HEALTHY dispatch — this is not the failure histogram', async () => {
    await seedAttempt(
      { resumed: false, dropReason: 'rotation', priorClaudeSessionId: 'cli-1' },
      { status: 'completed' },
    );
    const out = await readContinuity();
    expect(out.offered).toBe(1);
    expect(out.dropped).toBe(1);
    expect(out.rows).toEqual([{ reason: 'rotation', sessions: 1 }]);
  });

  it('scopes to the project asked for', async () => {
    const other = await createTestProject(harness.db, ownerId);
    const otherRun = await insertRun(other.id);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata, created_at, updated_at)
      VALUES (${randomUUID()}, ${other.id}, ${otherRun}, 'completed',
        ${JSON.stringify({ resume: { resumed: false, dropReason: 'rotation', priorClaudeSessionId: 'x' } })}::jsonb,
        now(), now())
    `);
    await seedAttempt({ resumed: true, dropReason: null, priorClaudeSessionId: 'cli-1' });
    const out = await readContinuity();
    expect(out.offered).toBe(1);
    expect(out.dropped).toBe(0);
  });
});
