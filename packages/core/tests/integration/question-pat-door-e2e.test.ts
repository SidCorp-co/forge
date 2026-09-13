/**
 * The door an agent that is not a runner box asks a question through.
 *
 * Until ISS-993 `agent_questions` had two doors and a personal access token
 * reached neither: the box's is behind `requireDevice()`, and `/api/questions`
 * belonged to no resource in the permission menu, so every one of the human
 * routes answered `PAT_NOT_PERMITTED`. What an agent did instead was write a
 * markdown comment with no option id, no round and no waiter.
 *
 * Real Postgres, because every claim here is about a ROW: that one is written
 * with the project the issue names, that none is written when the ask is
 * refused, that the list narrows to one project, and that the delivery
 * obligation ISS-978 derives sees a question asked through this door.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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

// cm:guard `bindsTo: 'session'`, because `checkOptions` refuses a `this_call` option carrying no fingerprint BEFORE anything else — an invalid option here would make every case below pass on the wrong refusal (the same fixture rule `question-issue-project-agree-e2e.test.ts` carries).
const WRITER = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};

let harness: TestDatabase;
let app: Hono<AppVars>;
let schema: typeof import('../../src/db/schema-questions.js');
let userId: string;
let projectId: string;
let issueId: string;
let writeToken: string;
let readToken: string;
let ungrantedToken: string;
let sessionJwt: string;
let strangerToken: string;
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
  schema = await import('../../src/db/schema-questions.js');
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
  const org = await seedOrg(harness.db, userId);
  projectId = (await createTestProject(harness.db, userId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { projectId, userId });
  issueId = await anIssue(projectId);

  const { mintPat } = await import('../../src/auth/pat.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');
  writeToken = (
    await mintPat({
      userId,
      name: 'asks',
      permissions: ['questions:read', 'questions:write'],
    })
  ).plaintext;
  readToken = (await mintPat({ userId, name: 'reads', permissions: ['questions:read'] })).plaintext;
  ungrantedToken = (await mintPat({ userId, name: 'ungranted' })).plaintext;
  sessionJwt = await signUserToken(userId);

  const stranger = await createTestUser(harness.db);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
  );
  strangerToken = (await mintPat({ userId: stranger.id, name: 'stranger' })).plaintext;
});

async function anIssue(project: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project}, ${seq}, ${`issue ${seq}`}, 'open', ${userId})
  `);
  return id;
}

function post(path: string, token: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

function askBody(over: Record<string, unknown> = {}) {
  return {
    issueId,
    prompt: 'Which way?',
    options: [WRITER],
    recommendedOptionId: WRITER.id,
    ...over,
  };
}

async function countQuestions(): Promise<number> {
  const rows = await harness.db.select().from(schema.agentQuestions);
  return rows.length;
}

describe('asking through the token door', () => {
  it('writes the question and answers with its id', async () => {
    const res = await post('/api/questions', writeToken, askBody());

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // cm:guard the project is the ISSUE's and never the caller's, which is what makes the crossed row ISS-989 refuses unrepresentable through this door rather than merely refused on it.
  it('stamps the project the issue belongs to', async () => {
    const res = await post('/api/questions', writeToken, askBody());
    const { id } = (await res.json()) as { id: string };

    const [row] = await harness.db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, id))
      .limit(1);

    expect(row?.projectId).toBe(projectId);
    expect(row?.issueId).toBe(issueId);
  });

  it('refuses an empty options array with a code of its own and writes no row', async () => {
    const res = await post('/api/questions', writeToken, askBody({ options: [] }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_OPTIONS_REQUIRED');
    expect(await countQuestions()).toBe(0);
  });

  it('refuses a recommended option that is not one of the options, and writes no row', async () => {
    const res = await post(
      '/api/questions',
      writeToken,
      askBody({ recommendedOptionId: randomUUID() }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_RECOMMENDED_UNKNOWN');
    expect(await countQuestions()).toBe(0);
  });

  // cm:guard every reader resolves an option by `find` and takes the first, so a repeated id records a choice nobody can read back — the refusal is at the write because there is no reader that can recover it afterwards.
  it('refuses two options sharing an id, and writes no row', async () => {
    const res = await post(
      '/api/questions',
      writeToken,
      askBody({ options: [WRITER, { ...WRITER, label: 'A different thing entirely' }] }),
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_OPTION_IDS_DUPLICATE');
    expect(await countQuestions()).toBe(0);
  });

  // cm:guard `agent_session_id` is a foreign key and this door takes no session from the caller, so a caller-named one cannot leave the insert as a 23503 and the handler as a 500. The schema is `.strict()`, which is what turns the field into a named refusal rather than a silently dropped key.
  it('refuses a caller-named agentSessionId rather than letting the foreign key 500', async () => {
    const res = await post('/api/questions', writeToken, askBody({ agentSessionId: randomUUID() }));

    expect(res.status).toBe(400);
    expect(await countQuestions()).toBe(0);
  });

  it('answers 404 for an issue that does not exist, and writes no row', async () => {
    const res = await post('/api/questions', writeToken, askBody({ issueId: randomUUID() }));

    expect(res.status).toBe(404);
    // cm:guard the refusal names the ISSUE, which is what the caller got wrong — this route takes an issue id and mints the question, so `question not found` sends them looking at the id they never sent.
    expect(await res.json()).toMatchObject({ message: 'issue not found' });
    expect(await countQuestions()).toBe(0);
  });

  // cm:guard a stranger gets the SAME 404 as a missing issue, asserted body and all: the two must stay indistinguishable, or the pair enumerates which issue ids exist to whoever can read both.
  it('answers 404 to a token whose owner holds no role on the project, and writes no row', async () => {
    const missing = await post('/api/questions', writeToken, askBody({ issueId: randomUUID() }));
    const res = await post('/api/questions', strangerToken, askBody());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
    expect(await countQuestions()).toBe(0);
  });

  it('refuses a token granted only questions:read, naming the permission it wanted', async () => {
    const res = await post('/api/questions', readToken, askBody());

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; details?: { wanted?: string } };
    expect(body.code).toBe('PAT_PERMISSION_REQUIRED');
    expect(body.details?.wanted).toBe('questions:write');
    expect(await countQuestions()).toBe(0);
  });
});

describe('listing what is waiting', () => {
  it('returns the open questions of one project', async () => {
    await post('/api/questions', writeToken, askBody());
    await post('/api/questions', writeToken, askBody());

    const res = await get(`/api/questions?projectId=${projectId}&status=open`, readToken);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { questions: unknown[] }).questions).toHaveLength(2);
  });

  // cm:guard the list is narrowed by `project_id` and never by what the caller happens to be a member of: a member of both projects reading project A's queue must not be handed B's prompts and options.
  it('returns no question of another project the same caller can also see', async () => {
    const other = await createTestProject(harness.db, userId, {
      orgId: (await seedOrg(harness.db, userId)).id,
    });
    await createTestProjectMember(harness.db, { projectId: other.id, userId });
    const otherIssue = await anIssue(other.id);
    await post('/api/questions', writeToken, askBody());
    await post('/api/questions', writeToken, askBody({ issueId: otherIssue }));

    const res = await get(`/api/questions?projectId=${other.id}&status=open`, readToken);

    const { questions } = (await res.json()) as { questions: { issueId: string }[] };
    expect(questions).toHaveLength(1);
    expect(questions[0]?.issueId).toBe(otherIssue);
  });

  // cm:guard the tie-break is the half that makes the order TOTAL: two questions asked in one transaction share a `created_at` to the microsecond, so `created_at` alone leaves a queue that reads differently on each call.
  it('orders newest first and breaks a tie on id descending', async () => {
    const first = await post('/api/questions', writeToken, askBody());
    const second = await post('/api/questions', writeToken, askBody());
    const ids = [
      ((await first.json()) as { id: string }).id,
      ((await second.json()) as { id: string }).id,
    ];
    await harness.db.execute(sql`UPDATE agent_questions SET created_at = now()`);

    const res = await get(`/api/questions?projectId=${projectId}`, readToken);

    const { questions } = (await res.json()) as { questions: { id: string }[] };
    expect(questions.map((q) => q.id)).toEqual([...ids].sort().reverse());
  });

  it('still answers the issue-scoped form', async () => {
    await post('/api/questions', writeToken, askBody());

    const res = await get(`/api/questions?issueId=${issueId}`, readToken);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { questions: unknown[] }).questions).toHaveLength(1);
  });

  it('refuses a request naming both an issue and a project', async () => {
    const res = await get(`/api/questions?issueId=${issueId}&projectId=${projectId}`, readToken);

    expect(res.status).toBe(400);
  });
});

describe('reading the answer back', () => {
  it('carries the option a person chose', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const answered = await post(`/api/questions/${id}/answer`, sessionJwt, {
      optionId: WRITER.id,
      round: 1,
    });
    expect(answered.status).toBe(200);

    const res = await get(`/api/questions/${id}`, readToken);
    const body = (await res.json()) as { steps: { chosenOptionId?: string }[] };
    expect(body.steps.at(-1)?.chosenOptionId).toBe(WRITER.id);
  });
});

describe('a malformed question id', () => {
  // cm:guard `agent_questions.id` is a uuid column, so a malformed literal raises 22P02 and leaves the handler as a 500 — a caller's typo reading as a server fault, on the very route an agent uses to read its answer back.
  it.each([
    '/api/questions/not-a-uuid',
    '/api/questions/not-a-uuid/answer',
    '/api/questions/not-a-uuid/void',
  ])('%s is a named 400 rather than a server error', async (path) => {
    const res = path.endsWith('uuid')
      ? await get(path, readToken)
      : await post(path, sessionJwt, { optionId: WRITER.id, round: 1, reason: 'x' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('BAD_REQUEST');
  });
});

describe("answering and voiding stay a session's", () => {
  // cm:guard the token is granted `questions:write`, so the grant check upstream has already passed and what refuses it is the handler itself — a token granted less would meet `PAT_PERMISSION_REQUIRED` in middleware and prove nothing about this rule.
  it('refuses an answer on a token that holds the permission the route wanted', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const res = await post(`/api/questions/${id}/answer`, writeToken, {
      optionId: WRITER.id,
      round: 1,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_NEEDS_SESSION');

    const [row] = await harness.db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, id))
      .limit(1);
    expect(row?.status).toBe('open');
    expect(schema.chosenOptionIdOf(row?.steps.at(-1))).toBeNull();
  });

  // cm:guard an UNGRANTED token is the one the widening actually exposed — an absent grant array reads as holding every group — so this is the case that would have been an open door.
  it('refuses an answer on a token granted nothing at all', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const res = await post(`/api/questions/${id}/answer`, ungrantedToken, {
      optionId: WRITER.id,
      round: 1,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_NEEDS_SESSION');
  });

  it('refuses a void on a token and leaves the question open', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const res = await post(`/api/questions/${id}/void`, writeToken, { reason: 'no longer needed' });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('QUESTION_NEEDS_SESSION');

    const [row] = await harness.db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, id))
      .limit(1);
    expect(row?.status).toBe('open');
  });

  it('lets a browser session answer, unchanged', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const res = await post(`/api/questions/${id}/answer`, sessionJwt, {
      optionId: WRITER.id,
      round: 1,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('answered');
  });
});

describe('the delivery ISS-978 already ships', () => {
  // cm:guard asserted against `owedRounds` itself and not against a second query shaped like it: the whole point of this door is that it writes an ORDINARY row, so the obligation must be derived by the code that already ships rather than by anything this change added.
  it('owes a round for a question asked through this door', async () => {
    const asked = await post('/api/questions', writeToken, askBody());
    const { id } = (await asked.json()) as { id: string };

    const { owedRounds } = await import('../../src/integrations/rocketchat/question-delivery.js');

    expect((await owedRounds()).map((r) => r.questionId)).toContain(id);
  });
});
