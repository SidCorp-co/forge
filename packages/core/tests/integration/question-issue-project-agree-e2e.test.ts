/**
 * A question names a project and an issue, and the two must agree.
 *
 * `agent_questions.project_id` and `issue_id` are independent columns, so a row
 * naming project A on an issue of project B is representable — and every reader
 * downstream reaches a question through one column or the other. The issue-
 * scoped list authorises on the issue's project and selected on `issue_id`; the
 * attention bucket's cost subqueries correlate on `issue_id`;
 * `answerReachesAParkedRun` matched on it too. Each of those narrowing to
 * exclude the crossed row is a different wrong answer, and none of them can tell
 * which of the two columns the caller meant (ISS-989).
 *
 * So the refusal is at the write, by name. These are its cases; the readers'
 * own cases live beside the reader each belongs to.
 *
 * Real Postgres, because the check is a select against `issues` and the claim
 * is that nothing is written when it refuses.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
let write: typeof import('../../src/questions/write.js');
let schema: typeof import('../../src/db/schema-questions.js');
let projectId: string;
let issueId: string;
let adminId: string;
let deviceId: string;
let deviceToken: string;
let app: typeof import('../../src/index.js').app;
let seq = 0;

// cm:guard `bindsTo: 'session'` and a uuid id, matching the fixture in `question-answer-atomic-e2e.test.ts`: `checkOptions` runs BEFORE the project check and refuses a `this_call` option carrying no fingerprint, so an invalid option here makes every case below pass on the wrong refusal.
const WRITER = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  write = await import('../../src/questions/write.js');
  schema = await import('../../src/db/schema-questions.js');
  ({ app } = await import('../../src/index.js'));
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  adminId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, adminId)).id;
  issueId = await anIssue();
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId: adminId, name: 'ask-box', platform: 'linux' });
  deviceId = issued.device.id;
  deviceToken = issued.plaintext;
});

// cm:guard the route refuses before `askQuestion` unless the box is bound to the project it names, so every route case binds first — without it the assertion would land on `assertDeviceBoundToProject` and never reach the check it is about.
async function bindDeviceTo(project: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (device_id, project_id, name, type, status)
    VALUES (${deviceId}, ${project}, 'ask-box', 'claude-code', 'online')
  `);
}

async function anIssue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'needs_info', ${adminId})
  `);
  return id;
}

function ask(over: Record<string, unknown> = {}) {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'Which way?',
    blockerKind: 'human',
    options: [WRITER],
    recommendedOptionId: WRITER.id,
    ...over,
  });
}

async function rowOf(id: string) {
  const [row] = await harness.db
    .select()
    .from(schema.agentQuestions)
    .where(eq(schema.agentQuestions.id, id))
    .limit(1);
  return row;
}

describe('asking a question about an issue of another project', () => {
  it('is refused, naming the project the issue actually belongs to', async () => {
    const elsewhere = await createTestProject(harness.db, adminId);

    await expect(ask({ projectId: elsewhere.id })).rejects.toThrow(
      new RegExp(`belongs to project ${projectId}`),
    );
  });

  // cm:guard a code of its own, not the generic one: web-v2's `formatApiError` turns a bare refusal into a sentence about permissions, and this is a malformed request rather than a denied one.
  it('is refused with a code of its own rather than a generic one', async () => {
    const elsewhere = await createTestProject(harness.db, adminId);

    await ask({ projectId: elsewhere.id }).then(
      () => expect.unreachable('the crossed question was written'),
      (e: { code?: string }) => expect(e.code).toBe('QUESTION_ISSUE_ELSEWHERE'),
    );
  });

  // cm:guard the refusal must leave NO row. A written-then-rejected question is the crossed row this refusal exists to prevent, arriving by the path that reports it refused.
  it('writes no row when it refuses', async () => {
    const elsewhere = await createTestProject(harness.db, adminId);
    const id = randomUUID();

    await ask({ projectId: elsewhere.id, id }).catch(() => {});

    expect(await rowOf(id)).toBeUndefined();
  });

  it('refuses a question naming an issue that does not exist at all', async () => {
    await expect(ask({ issueId: randomUUID() })).rejects.toThrow(/no issue/);
  });
});

describe('the route a box reaches this by', () => {
  // cm:guard asserted through the ROUTE and not through `askQuestion`, because the code's whole purpose is to reach the box: this handler is the only producer of the ask-time refusals and it used to flatten every one of them to `BAD_REQUEST`, leaving the per-refusal distinction alive in the type system and dead on the wire (ISS-989).
  it('answers the crossed question with its own code, not a flattened BAD_REQUEST', async () => {
    const elsewhere = await createTestProject(harness.db, adminId);
    await bindDeviceTo(elsewhere.id);

    const res = await app.request('/api/devices/me/questions', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: randomUUID(),
        projectId: elsewhere.id,
        issueId,
        prompt: 'Which way?',
        blockerKind: 'human',
        options: [WRITER],
        recommendedOptionId: WRITER.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('QUESTION_ISSUE_ELSEWHERE');
    expect(body.message).toContain(projectId);
  });

  it('takes the same question when the issue is in the project the box names', async () => {
    await bindDeviceTo(projectId);

    const res = await app.request('/api/devices/me/questions', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: randomUUID(),
        projectId,
        issueId,
        prompt: 'Which way?',
        blockerKind: 'human',
        options: [WRITER],
        recommendedOptionId: WRITER.id,
      }),
    });

    expect(res.status).toBe(200);
  });
});

describe('the questions this refusal must not touch', () => {
  // cm:guard a question with NO issue is legal and must stay legal: a project-level question hangs off no issue, and a check demanding one would refuse every one of them.
  it('still writes a question that names no issue', async () => {
    const q = await ask({ issueId: undefined });

    expect(await rowOf(q.id)).toBeTruthy();
  });

  it('still writes a question whose issue is in the project it names', async () => {
    const q = await ask();

    expect((await rowOf(q.id))?.issueId).toBe(issueId);
  });
});
