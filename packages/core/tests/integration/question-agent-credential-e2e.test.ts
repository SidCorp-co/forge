/**
 * ISS-1003 — the one credential that may answer a question blocked on another
 * agent.
 *
 * `blockerKind: 'master_or_peer'` says in the row that what this run waits on
 * is another agent. No credential could answer it: every token was refused at
 * the door and no agent held a session, so a peer-blocked park could only ever
 * be cleared by a person standing in for the peer. The refusal was right and
 * unavoidable, because the only test available was `agency`, which read `human`
 * for an agent on a borrowed token.
 *
 * Real Postgres, because the claim is about WHICH credential: a token minted
 * for an agent account and a token minted for a person are the same table, the
 * same middleware and the same shape, and the only thing that separates them is
 * the `users.kind` of the row the token's `user_id` points at. Mock any part of
 * that and the test stops being about the distinction it exists to prove.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

// cm:guard `bindsTo: 'session'`, because `checkOptions` refuses a `this_call` option carrying no fingerprint BEFORE anything else — an invalid option would make every case below pass on the wrong refusal.
const OPTION = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};

let harness: TestDatabase;
let app: Hono<AppVars>;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let personToken: string;
let agentToken: string;
let sessionJwt: string;
let userId: string;
let projectId: string;
let orgId: string;
let issueId: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';
  accounts = await import('../../src/orgs/agent-accounts.js');
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono<AppVars> });
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  const user = await createTestUser(harness.db);
  userId = user.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${userId}`);
  orgId = (await seedOrg(harness.db, userId)).id;
  projectId = (await createTestProject(harness.db, userId, { orgId })).id;
  await createTestProjectMember(harness.db, { projectId, userId });
  issueId = await anIssue();

  const { mintPat } = await import('../../src/auth/pat.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');
  personToken = (await mintPat({ userId, name: 'a person’s own token' })).plaintext;
  sessionJwt = await signUserToken(userId);
  agentToken = (await accounts.createAgentAccount({ orgId, projectId, handle: 'peer-agent' }))
    .plaintext;
});

async function anIssue(): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${userId})
  `);
  return id;
}

async function ask(blockerKind: 'human' | 'master_or_peer'): Promise<string> {
  const res = await app.request('/api/questions', {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionJwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      issueId,
      prompt: 'Which way?',
      options: [OPTION],
      recommendedOptionId: OPTION.id,
      blockerKind,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function answer(id: string, token: string) {
  return app.request(`/api/questions/${id}/answer`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: OPTION.id, round: 1 }),
  });
}

describe('a question blocked on another agent', () => {
  // cm:guard this is the hole the whole attribution split was for: the answer is admitted because the credential NAMES an agent, and `agentUserId` is set only where the token's owner is an agent account. Widen the admission to `agency === 'agent'` and the person's token below is admitted with it, because that is exactly where the wrong answer lived.
  it('is answered by an agent holding its own Agent Access Token', async () => {
    const id = await ask('master_or_peer');
    const res = await answer(id, agentToken);
    expect(res.status).toBe(200);

    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM agent_questions WHERE id = ${id}`,
    );
    expect(row?.status).toBe('answered');
  });

  it('refuses a token a person owns, and names the credential that would be accepted', async () => {
    const id = await ask('master_or_peer');
    const res = await answer(id, personToken);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('QUESTION_NEEDS_AGENT_CREDENTIAL');
    // cm:guard the refusal must say what WOULD work and where to get it, because the caller that meets it is a run mid-park with no way to discover the answer from a bare 403. The route it names is the one ISS-1003 added for exactly this population.
    expect(body.message).toContain('Agent Access Token');
    expect(body.message).toContain('/api/orgs/:orgId/agents/:agentUserId/tokens');

    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM agent_questions WHERE id = ${id}`,
    );
    expect(row?.status).toBe('open');
  });

  it('is still answered by a person in a session', async () => {
    const id = await ask('master_or_peer');
    const res = await answer(id, sessionJwt);
    expect(res.status).toBe(200);
  });
});

describe('a question blocked on a person', () => {
  // cm:guard the blocker kind is checked as well as the credential, and it is not decoration: a question parked on a HUMAN was escalated precisely because a machine should not decide it, so an agent credential is refused here and told to sign in. Drop the blockerKind test and an agent answers every park in the tracker.
  it('refuses an agent holding its own token, and sends it to a person', async () => {
    const id = await ask('human');
    const res = await answer(id, agentToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('QUESTION_NEEDS_SESSION');
  });

  it('refuses a token a person owns, unchanged', async () => {
    const id = await ask('human');
    const res = await answer(id, personToken);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('QUESTION_NEEDS_SESSION');
  });
});
