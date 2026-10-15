/**
 * ISS-1133 r3 — the issue page and the work-evidence gate read one branch.
 *
 * The rail printed `ISS-<seq>` under "Branch" for every issue while the gate refused the same
 * issue `NO_WORK_EVIDENCE` for having no branch recorded. The detail answer now carries the
 * gate's own reading, so each fixture is read through both doors and the two must agree: no branch
 * at all, a branch the gate counts, one under the worklog, and the base branch, which names where
 * work lands rather than that any happened and so counts as none.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let token: string;
let ownerId: string;
let projectId: string;
let seq = 40;

let collectWorkEvidence: typeof import('../../src/pipeline/work-evidence.js').collectWorkEvidence;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ collectWorkEvidence } = await import('../../src/pipeline/work-evidence.js'));
  const { signUserToken } = await import('../../src/auth/jwt.js');
  server = await startTestServer();
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  token = await signUserToken(ownerId);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  await harness.db.execute(sql`UPDATE projects SET base_branch = 'main' WHERE id = ${projectId}`);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

async function seedIssue(sessionContext: Record<string, unknown> | null): Promise<{
  id: string;
  issSeq: number;
}> {
  const id = randomUUID();
  const issSeq = seq++;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, session_context)
    VALUES (${id}, ${projectId}, ${issSeq}, 'which branch', 'in_progress', 'medium', ${ownerId},
            ${sessionContext === null ? null : JSON.stringify(sessionContext)}::jsonb)
  `);
  return { id, issSeq };
}

async function detail(path: string): Promise<{ recordedBranch?: unknown; displayId?: string }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { recordedBranch?: unknown; displayId?: string };
}

describe('the branch the issue page shows is the branch the gate counts', () => {
  it.each([
    ['no session context', null, null],
    ['a session context naming no branch', { worklog: {} }, null],
    ['a branch', { branch: 'ISS-41-a-branch' }, 'ISS-41-a-branch'],
    ['a branch under the worklog', { worklog: { branch: 'ISS-42-worklog' } }, 'ISS-42-worklog'],
    ['the base branch', { branch: 'main' }, null],
  ])('with %s, both detail answers carry what the gate reads', async (_, context, expected) => {
    const issue = await seedIssue(context);

    const gate = await collectWorkEvidence(issue.id);
    const byId = await detail(`/api/issues/${issue.id}`);
    const byKey = await detail(`/api/projects/${projectId}/issues/by-display/ISS-${issue.issSeq}`);

    expect(gate.branch).toBe(expected);
    expect(byId.recordedBranch).toBe(expected);
    expect(byKey.recordedBranch).toBe(expected);
    expect(byId.recordedBranch).not.toBe(byId.displayId);
  });
});
