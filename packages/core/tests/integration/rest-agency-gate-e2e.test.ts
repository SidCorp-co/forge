/**
 * The REST half of the agency axis.
 *
 * `PATCH /api/issues/batch` transitions, and it is reachable with a personal
 * access token (`/api/issues` is on the PAT allowlist). MCP enforces the
 * ISS-786 evidence gate on an agent because it synthesizes a device for a PAT
 * principal; REST has no device to synthesize, so before `restActor` carried
 * `agency` every PAT-held caller here was a human and the gate never ran.
 *
 * The two cases are one falsification pair: same request, same issue, same
 * absent evidence — only the credential class differs.
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
let mintJobToken: typeof import('../../src/jobs/job-token.js').mintJobToken;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [extras, mergeMod, errMod, reqIdMod, tok, pat] = await Promise.all([
    import('../../src/issues/extras-routes.js'),
    import('../../src/issues/merge-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/jobs/job-token.js'),
    import('../../src/auth/pat.js'),
  ]);
  mintJobToken = tok.mintJobToken;
  mintPat = pat.mintPat;

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/issues', extras.issueExtrasRoutes);
  app.route('/api/issues', mergeMod.issueMergeRoutes);
  app.onError(errMod.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** An issue sitting at `approved` with no branch, no job, no code evidence. */
async function seedEvidenceLessIssue() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}::uuid`,
  );
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status, plan)
    VALUES (${issueId}::uuid, ${project.id}::uuid, 'nothing was built for this',
            ${user.id}::uuid, 'approved', 'a plan exists so only the work evidence is missing')
  `);
  return { user, project, issueId };
}

async function jobPatFor(user: { id: string }, project: { id: string }): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}::uuid, ${project.id}::uuid, 'system', 'running', now())
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status)
    VALUES (${jobId}::uuid, ${project.id}::uuid, ${runId}::uuid, ${user.id}::uuid, 'code', 'running')
  `);
  return (await mintJobToken({ id: jobId, projectId: project.id, createdBy: user.id })) as string;
}

const advance = (token: string, issueId: string) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [issueId], data: { status: 'developed' } }),
  });

describe('PATCH /api/issues/batch honours agency, not just device-ness', () => {
  it('refuses an agent-held token the evidence-less advance', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const res = await advance(await jobPatFor(user, project), issueId);

    expect(JSON.stringify(await res.json())).toContain('no_work_evidence');
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}::uuid`,
    );
    expect(row?.status).toBe('approved');
  });

  // cm:guard the human half is not decoration — it is what proves the gate is reading agency rather than simply refusing everyone. Identical request, identical missing evidence; only the token's name prefix differs, and a person hand-advancing their own issue must keep working (that carve-out is the whole reason the gate is scoped at all).
  it('lets a person through the same request', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const { plaintext } = await mintPat({
      userId: user.id,
      name: 'my laptop',
      boundProjectId: project.id,
    });
    const res = await advance(plaintext, issueId);

    expect(JSON.stringify(await res.json())).not.toContain('no_work_evidence');
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}::uuid`,
    );
    expect(row?.status).toBe('developed');
  });
});

describe('POST/DELETE /api/issues/:id/merge — the CLI route for a merge claim', () => {
  const merge = (token: string, issueId: string, method: 'POST' | 'DELETE', body: unknown = {}) =>
    app.request(`/api/issues/${issueId}/merge`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const mergedAtOf = async (issueId: string) => {
    const [row] = await harness.db.execute<{ merged_at: string | null }>(
      sql`SELECT merged_at FROM issues WHERE id = ${issueId}::uuid`,
    );
    return row?.merged_at ?? null;
  };

  it('refuses an agent the claim when no work evidence exists', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const res = await merge(await jobPatFor(user, project), issueId, 'POST', { target: 'main' });

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('NO_WORK_EVIDENCE');
    expect(await mergedAtOf(issueId)).toBeNull();
  });

  it('lets a person make the same claim, and take it back', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const { plaintext } = await mintPat({
      userId: user.id,
      name: 'my laptop',
      boundProjectId: project.id,
    });

    expect((await merge(plaintext, issueId, 'POST', { target: 'main' })).status).toBe(200);
    expect(await mergedAtOf(issueId)).not.toBeNull();

    expect((await merge(plaintext, issueId, 'DELETE')).status).toBe(200);
    expect(await mergedAtOf(issueId)).toBeNull();
  });

  // cm:guard `target` is the audit label the claim is recorded under, so a POST without one records "merged" with no statement of where — refuse it here rather than defaulting, because a default is indistinguishable in the audit trail from a caller who meant it.
  it('refuses a claim that does not say where it merged', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const { plaintext } = await mintPat({
      userId: user.id,
      name: 'my laptop',
      boundProjectId: project.id,
    });
    expect((await merge(plaintext, issueId, 'POST')).status).toBe(400);
    expect(await mergedAtOf(issueId)).toBeNull();
  });
});
