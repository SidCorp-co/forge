/**
 * The REST half of the agency axis.
 *
 * `PATCH /api/issues/batch` transitions, and it is reachable with a personal
 * access token (`/api/issues` is on the PAT allowlist). The ISS-786 evidence
 * gate runs on an agent and not on a person, so the question every case here
 * asks is which of the two a credential names.
 *
 * Each pair is one falsification set: same request, same issue, same absent
 * evidence — only the credential differs. Three credentials appear, and the
 * third carries the rule this file exists for (ISS-1137): a token a PERSON
 * owns is that person, because `users.kind` of the account it belongs to says
 * so. Nothing about a token's name, its transport or its absence of a device
 * may add to that answer.
 *
 * The cost is deliberate and is the point: an unattended box holding a
 * person's PAT is not held to the agent gates. `issues/park-question.ts`
 * states the remedy in its own refusal — such a box wants an agent account or
 * a paired device, not a person's credential — and the agent cases below are
 * what prove the gate still bites for one credentialed that way.
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
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

  const [extras, mergeMod, errMod, reqIdMod, pat, jwt] = await Promise.all([
    import('../../src/issues/extras-routes.js'),
    import('../../src/issues/merge-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/pat.js'),
    import('../../src/auth/jwt.js'),
  ]);
  mintPat = pat.mintPat;
  signUserToken = jwt.signUserToken;

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

/**
 * A credential an unattended agent holds: an ordinary PAT whose OWNER is a
 * `kind:'agent'` user. Since ISS-932 wave 4 that ownership is the whole of what
 * makes it read `agency:'agent'` — there is no token name to imitate.
 */
async function agentPatFor(project: { id: string }): Promise<string> {
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
  return plaintext;
}

const advance = (token: string, issueId: string) =>
  app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [issueId], data: { status: 'developed' } }),
  });

describe('PATCH /api/issues/batch honours agency, not just device-ness', () => {
  it('refuses an agent-held token the evidence-less advance', async () => {
    const { project, issueId } = await seedEvidenceLessIssue();
    const res = await advance(await agentPatFor(project), issueId);

    expect(JSON.stringify(await res.json())).toContain('no_work_evidence');
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}::uuid`,
    );
    expect(row?.status).toBe('approved');
  });

  it('lets a person in a session through the same request', async () => {
    const { user, issueId } = await seedEvidenceLessIssue();
    const res = await advance(await signUserToken(user.id), issueId);

    expect(JSON.stringify(await res.json())).not.toContain('no_work_evidence');
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${issueId}::uuid`,
    );
    expect(row?.status).toBe('developed');
  });

  it('lets a token a person owns through, because it is that person', async () => {
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
    const { project, issueId } = await seedEvidenceLessIssue();
    const res = await merge(await agentPatFor(project), issueId, 'POST', { target: 'main' });

    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('NO_WORK_EVIDENCE');
    expect(await mergedAtOf(issueId)).toBeNull();
  });

  it('lets a person in a session make the same claim, and take it back', async () => {
    const { user, issueId } = await seedEvidenceLessIssue();
    const session = await signUserToken(user.id);

    expect((await merge(session, issueId, 'POST', { target: 'main' })).status).toBe(200);
    expect(await mergedAtOf(issueId)).not.toBeNull();

    expect((await merge(session, issueId, 'DELETE')).status).toBe(200);
    expect(await mergedAtOf(issueId)).toBeNull();
  });

  it('allows the claim on a token a person owns, as it does in their session', async () => {
    const { user, project, issueId } = await seedEvidenceLessIssue();
    const { plaintext } = await mintPat({
      userId: user.id,
      name: 'my laptop',
      boundProjectId: project.id,
    });
    const res = await merge(plaintext, issueId, 'POST', { target: 'main' });

    expect(res.status).toBe(200);
    expect(await mergedAtOf(issueId)).not.toBeNull();
  });

  it('refuses a claim that does not say where it merged', async () => {
    const { user, issueId } = await seedEvidenceLessIssue();
    expect((await merge(await signUserToken(user.id), issueId, 'POST')).status).toBe(400);
    expect(await mergedAtOf(issueId)).toBeNull();
  });
});
