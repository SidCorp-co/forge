/**
 * ISS-1133 — the work-evidence gate reads the issue's own row, against a real Postgres.
 *
 * A drive handoff carrying `commitSha` is no evidence: an agent's move to `developed` on an issue
 * whose only trace is one is refused. A merged commit on the row is evidence with no handoff at all.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [extras, errMod, reqIdMod, pat] = await Promise.all([
    import('../../src/issues/extras-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/pat.js'),
  ]);
  mintPat = pat.mintPat;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/issues', extras.issueExtrasRoutes);
  app.onError(errMod.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** An `approved` issue with a plan and no branch, and the agent token that would advance it. */
async function seed() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status, plan)
    VALUES (${issueId}::uuid, ${project.id}::uuid, 'the gate reads this row',
            ${user.id}::uuid, 'approved', 'a plan exists so only the work evidence is in question')
  `);
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${project.id}::uuid, ${agent.id}::uuid, 'admin')`,
  );
  const { plaintext } = await mintPat({
    userId: agent.id,
    name: `agent for ${project.id}`,
    scopes: ['read', 'write'],
    boundProjectId: project.id,
  });
  return { projectId: project.id, issueId, token: plaintext };
}

async function driveHandoff(projectId: string, issueId: string, commitSha: string) {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
  `);
  const payload = {
    step: 'drive',
    schema_version: 1,
    outcome: 'advanced',
    summary: 'built and pushed',
    workDone: ['the change'],
    openQuestions: [],
    commitSha,
  };
  await harness.db.execute(sql`
    INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, payload)
    VALUES (${projectId}, ${issueId}, ${runId}, 'handoff', 'drive', ${JSON.stringify(payload)}::jsonb)
  `);
}

const advance = (token: string, issueId: string) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [issueId], data: { status: 'developed' } }),
  });

const statusOf = async (issueId: string) => {
  const [row] = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}::uuid`,
  );
  return row?.status;
};

describe('the work-evidence gate reads the issue row (ISS-1133)', () => {
  it('refuses an agent the move when a drive handoff commit is the only trace (criterion 1)', async () => {
    const { projectId, issueId, token } = await seed();
    await driveHandoff(projectId, issueId, 'a'.repeat(40));

    const res = await advance(token, issueId);

    expect(JSON.stringify(await res.json())).toContain('no_work_evidence');
    expect(await statusOf(issueId)).toBe('approved');
  });

  it('admits the move on a merged commit the row holds, with no handoff row (criterion 2)', async () => {
    const { issueId, token } = await seed();
    await harness.db.execute(sql`
      UPDATE issues SET merged_at = now(), merged_commit_sha = ${'b'.repeat(40)}
      WHERE id = ${issueId}::uuid
    `);
    const [handoffs] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issue_step_contexts WHERE issue_id = ${issueId}::uuid`,
    );
    expect(handoffs?.n).toBe(0);

    const res = await advance(token, issueId);

    expect(JSON.stringify(await res.json())).not.toContain('no_work_evidence');
    expect(await statusOf(issueId)).toBe('developed');
  });
});
