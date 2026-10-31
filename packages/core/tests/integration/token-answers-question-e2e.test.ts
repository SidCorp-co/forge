// @direct-test-of packages/core/src/questions/unanswerable-ask.ts
/**
 * A person's own token answers a question that person owes (owner, 2026-10-16), over REST and over
 * `/mcp` alike: a personal access token they minted, or the access token an MCP client holds on
 * their consent. It answers exactly what they could answer signed in — the session's own check —
 * and the answered round records the token and, for OAuth, the client (REQ-27 BC-2). A question
 * blocked on an agent or a peer keeps the agent-token rule, an agent's token is refused one that is a
 * person's (serious, on a strict project: REQ-79 BC-14; the rest of that rule is
 * question-door-agent-decides-e2e's), a token handed to act for someone answers nothing, the token's grant still applies, and a second
 * answer meets the not-open refusal.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import type { StatedPatGrant } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import type { QuestionOption } from '../../src/db/schema-questions.js';
import { app } from '../../src/index.js';
import { askQuestion } from '../../src/questions/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { declareControls } from '../helpers/project-controls.js';

type Json = Record<string, unknown>;
type McpAnswer = { isError: boolean; text: string; json: Json };

const ORIGIN = 'http://forge.test';
const REDIRECT = 'http://127.0.0.1:43123/callback';

let projectId = '';
let ownerId = '';
let memberId = '';
let agentId = '';
/** Who asks the questions standing on no record (ISS-812 refuses one naming nothing). */
let askerId = '';
const tok = { owner: '', member: '', agent: '', memberSession: '' };
const tokenIds = { owner: '', member: '' };

async function minted(userId: string, name: string, permissions: StatedPatGrant = ['*']) {
  const { row, plaintext } = await mintPat({ userId, name, projectIds: [projectId], permissions });
  return { id: row.id, token: plaintext };
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'owner');
  memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  askerId = (await createTestUser({ verified: true })).id;
  const owner = await minted(ownerId, 'owner-cli');
  const member = await minted(memberId, 'member-cli');
  tok.owner = owner.token;
  tokenIds.owner = owner.id;
  tok.member = member.token;
  tokenIds.member = member.id;
  tok.agent = (await minted(agentId, 'agent-own')).token;
  tok.memberSession = await userToken(memberId);
});

const OPTIONS: QuestionOption[] = [
  { id: 'ship', label: 'Ship it', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
  { id: 'freeze', label: 'Freeze', authority: 'admin', bindsTo: 'project', executedBy: 'core' },
];

/** An open question in `project`, blocked on `blocker`; free text unless `choice`. */
async function asked(
  blocker: 'human' | 'master_or_peer',
  opts: { choice?: boolean; project?: string; requirementId?: string; serious?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await askQuestion({
    id,
    projectId: opts.project ?? projectId,
    askedBy: askerId,
    ...(opts.requirementId ? { requirementId: opts.requirementId } : {}),
    prompt: 'Which flag guards the tour?',
    blockerKind: blocker,
    ...(opts.serious ? { serious: true } : {}),
    answer: opts.choice
      ? { shape: 'choice', options: OPTIONS, recommendedOptionId: 'ship' }
      : { shape: 'free_text', needed: 'the flag', recommended: 'tours.v2' },
  });
  return id;
}

const answerRest = (token: string, questionId: string, body: Json) =>
  api(token, 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

async function mcp(token: string, name: string, args: Json): Promise<McpAnswer> {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body.result as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? '';
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {}
  return { isError: result.isError === true, text, json };
}

const answerMcp = (token: string, questionId: string, body: Json) =>
  mcp(token, 'forge_questions', { action: 'answer', projectId, questionId, round: 1, ...body });

const mcpCode = (a: McpAnswer) => {
  expect(a.isError, a.text).toBe(true);
  return (a.json.error as { code?: string } | undefined)?.code ?? a.text;
};

/** The question's status and its answered round as stored, with the kernel move that answered it. */
async function stored(questionId: string) {
  const [row] = await rows<{ status: string; steps: Json[] }>(
    sql`SELECT status, steps FROM agent_questions WHERE id = ${questionId}`,
  );
  const [move] = await rows<{ actor_id: string; actor_token_id: string | null }>(
    sql`SELECT actor_id, actor_token_id FROM kernel_transitions
        WHERE entity_id = ${questionId} AND to_status = 'answered'`,
  );
  return { status: row?.status, round: row?.steps.at(-1) ?? {}, move };
}

describe('a person’s own personal access token', () => {
  it('answers a question they owe over REST, recording the token on the answer', async () => {
    const questionId = await asked('human');
    const res = await answerRest(tok.member, questionId, { text: 'tours.v2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { status, round, move } = await stored(questionId);
    expect(status).toBe('answered');
    expect(round).toMatchObject({
      answerText: 'tours.v2',
      answeredBy: memberId,
      answeredWith: { tokenId: tokenIds.member, client: null },
    });
    expect(move).toEqual({ actor_id: memberId, actor_token_id: tokenIds.member });
  });

  it('answers it over /mcp with forge_questions, recording the token the same way', async () => {
    const questionId = await asked('human', { choice: true });
    const res = await answerMcp(tok.member, questionId, { optionId: 'ship' });
    expect(res.isError, res.text).toBe(false);
    const { status, round } = await stored(questionId);
    expect(status).toBe('answered');
    expect(round).toMatchObject({
      chosenOptionId: 'ship',
      answeredBy: memberId,
      answeredWith: { tokenId: tokenIds.member, client: null },
    });
  });

  it('answers a question standing on a requirement through forge_requirements', async () => {
    const requirement = await createTestRequirement(projectId, 7, 'Tours guard behind a flag');
    const questionId = await asked('human', { requirementId: requirement.id });
    const elsewhere = await asked('human');
    const notOnIt = await mcp(tok.member, 'forge_requirements', {
      action: 'answer',
      projectId,
      requirement: requirement.key,
      questionId: elsewhere,
      round: 1,
      answer: 'tours.v2',
    });
    expect(notOnIt.isError).toBe(true);
    expect(notOnIt.text).toContain(`does not stand on ${requirement.key}`);
    expect((await stored(elsewhere)).status).toBe('open');

    const res = await mcp(tok.member, 'forge_requirements', {
      action: 'answer',
      projectId,
      requirement: requirement.key,
      questionId,
      round: 1,
      answer: 'tours.v2',
    });
    expect(res.isError, res.text).toBe(false);
    const { status, round } = await stored(questionId);
    expect(status).toBe('answered');
    expect(round).toMatchObject({
      answerText: 'tours.v2',
      answeredWith: { tokenId: tokenIds.member, client: null },
    });
  });

  it('gets the not-open refusal answering twice, at either door', async () => {
    const questionId = await asked('human');
    expect((await answerRest(tok.member, questionId, { text: 'tours.v2' })).status).toBe(200);
    const again = await answerRest(tok.member, questionId, { text: 'tours.v3' });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('QUESTION_NOT_OPEN');
    expect(mcpCode(await answerMcp(tok.member, questionId, { text: 'tours.v3' }))).toBe(
      'QUESTION_NOT_OPEN',
    );
    expect((await stored(questionId)).round).toMatchObject({ answerText: 'tours.v2' });
  });
});

describe('the owner’s reach, nothing more', () => {
  it('refuses a question owed in a project its owner holds no role on, as a session is refused', async () => {
    const strangerId = (await createTestUser({ verified: true })).id;
    const theirs = (await createTestProject(strangerId)).id;
    const questionId = await asked('human', { project: theirs });
    const viaToken = await answerRest(tok.member, questionId, { text: 'tours.v2' });
    const viaSession = await answerRest(tok.memberSession, questionId, { text: 'tours.v2' });
    expect(viaToken.status).toBe(404);
    expect(viaToken.body.code).toBe('NOT_FOUND');
    expect(viaSession.status).toBe(viaToken.status);
    expect((await stored(questionId)).status).toBe('open');
  });

  it('refuses an option whose authority the owner does not hold, naming the permission', async () => {
    const questionId = await asked('human', { choice: true });
    const viaToken = await answerRest(tok.member, questionId, { optionId: 'freeze' });
    const viaSession = await answerRest(tok.memberSession, questionId, { optionId: 'freeze' });
    expect(viaToken.status).toBe(403);
    expect(viaToken.body.code).toBe('PERMISSION_FORBIDDEN');
    expect(JSON.stringify(viaToken.body)).toContain('project.admin');
    expect(viaSession.body.code).toBe(viaToken.body.code);
    const overMcp = await answerMcp(tok.member, questionId, { optionId: 'freeze' });
    expect(mcpCode(overMcp)).toBe('PERMISSION_FORBIDDEN');
    expect((await stored(questionId)).status).toBe('open');
    expect((await answerRest(tok.owner, questionId, { optionId: 'freeze' })).status).toBe(200);
  });
});

describe('a question blocked on an agent or a peer', () => {
  it('is still answered by the agent’s own token', async () => {
    const questionId = await asked('master_or_peer');
    const res = await answerRest(tok.agent, questionId, { text: 'tours.v2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(questionId)).round).toMatchObject({ answeredBy: agentId });
  });

  it('refuses a person’s own token by name, even one holding every permission, at either door', async () => {
    const questionId = await asked('master_or_peer', { choice: true });
    const viaRest = await answerRest(tok.owner, questionId, { optionId: 'ship' });
    expect(viaRest.status).toBe(403);
    expect(viaRest.body.code).toBe('QUESTION_BLOCKED_ON_AGENT');
    expect(JSON.stringify(viaRest.body)).toContain('Agent Access Token');
    const viaMcp = await answerMcp(tok.owner, questionId, { optionId: 'ship' });
    expect(mcpCode(viaMcp)).toBe('QUESTION_BLOCKED_ON_AGENT');
    expect((await stored(questionId)).status).toBe('open');
    const byAgent = await answerRest(tok.agent, questionId, { optionId: 'ship' });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(200);
  });

  it('refuses an agent’s token a question a person owes, serious on a strict project, by name', async () => {
    await declareControls(projectId, ownerId, { gates: { profile: 'strict' } });
    const questionId = await asked('human', { serious: true });
    const res = await answerRest(tok.agent, questionId, { text: 'tours.v2', note: 'my call' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUESTION_OWED_BY_PERSON');
    expect(
      mcpCode(await answerMcp(tok.agent, questionId, { text: 'tours.v2', note: 'my call' })),
    ).toBe('QUESTION_OWED_BY_PERSON');
    expect((await stored(questionId)).status).toBe('open');
  });
});

describe('a token that is not its holder’s own word', () => {
  it('refuses a token handed to act for someone, at either door', async () => {
    const { plaintext } = await mintPat({
      userId: memberId,
      name: 'handed',
      projectIds: [projectId],
      permissions: ['*'],
      onBehalfOf: memberId,
    });
    const questionId = await asked('human');
    const res = await answerRest(plaintext, questionId, { text: 'tours.v2' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUESTION_TOKEN_NOT_OWN');
    expect(mcpCode(await answerMcp(plaintext, questionId, { text: 'tours.v2' }))).toBe(
      'QUESTION_TOKEN_NOT_OWN',
    );
    expect((await stored(questionId)).status).toBe('open');
  });
});

describe('the token’s grant still applies', () => {
  it('refuses a token granted only questions:read, at either door', async () => {
    const reader = await minted(memberId, 'member-reader', ['questions:read']);
    const questionId = await asked('human');
    const res = await answerRest(reader.token, questionId, { text: 'tours.v2' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAT_PERMISSION_REQUIRED');
    const overMcp = await answerMcp(reader.token, questionId, { text: 'tours.v2' });
    expect(overMcp.isError).toBe(true);
    expect(overMcp.text).toContain('questions:write');
    expect((await stored(questionId)).status).toBe('open');
  });
});

describe('the access token an MCP client holds on the person’s consent', () => {
  function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  }

  /** Claude Code signed in as the member end to end: the client's id and its access token. */
  async function signedIn(): Promise<{ clientId: string; accessToken: string }> {
    await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${memberId}`);
    const registered = await api(null, 'POST', '/api/mcp-auth/register', {
      client_name: 'Claude Code',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    const clientId = registered.body.client_id as string;
    const { verifier, challenge } = pkce();
    const consented = await api(tok.memberSession, 'POST', '/api/mcp-auth/authorize', {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-1',
      decision: 'allow',
      project_ids: [projectId],
      permissions: ['*'],
    });
    expect(consented.status, JSON.stringify(consented.body)).toBe(200);
    const code = new URL(consented.body.redirectTo as string).searchParams.get('code') as string;
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/mcp-auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      }),
    );
    const body = (await res.json()) as Record<string, string>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return { clientId, accessToken: body.access_token as string };
  }

  const liveTokenOf = async (userId: string) =>
    (
      await rows<{ id: string }>(
        sql`SELECT id FROM personal_access_tokens
            WHERE user_id = ${userId} AND name LIKE 'mcp oauth %' AND revoked_at IS NULL`,
      )
    )[0]?.id;

  it('answers over /mcp, recording the token and the client it was handed to', async () => {
    const { clientId, accessToken } = await signedIn();
    const questionId = await asked('human');
    const res = await answerMcp(accessToken, questionId, { text: 'tours.v2' });
    expect(res.isError, res.text).toBe(false);
    const { status, round, move } = await stored(questionId);
    expect(status).toBe('answered');
    const tokenId = await liveTokenOf(memberId);
    expect(round).toMatchObject({
      answeredBy: memberId,
      answeredWith: { tokenId, client: { id: clientId, name: 'Claude Code' } },
    });
    expect(move?.actor_token_id).toBe(tokenId);
  });

  it('is refused a question blocked on an agent, by name', async () => {
    const { accessToken } = await signedIn();
    const questionId = await asked('master_or_peer');
    const viaRest = await answerRest(accessToken, questionId, { text: 'tours.v2' });
    expect(viaRest.status).toBe(403);
    expect(viaRest.body.code).toBe('QUESTION_BLOCKED_ON_AGENT');
    expect(mcpCode(await answerMcp(accessToken, questionId, { text: 'tours.v2' }))).toBe(
      'QUESTION_BLOCKED_ON_AGENT',
    );
    expect((await stored(questionId)).status).toBe('open');
  });

  it('answers over REST the same way, and is held to the owner’s reach', async () => {
    const { clientId, accessToken } = await signedIn();
    const questionId = await asked('human', { choice: true });
    const beyond = await answerRest(accessToken, questionId, { optionId: 'freeze' });
    expect(beyond.status).toBe(403);
    expect(beyond.body.code).toBe('PERMISSION_FORBIDDEN');
    const res = await answerRest(accessToken, questionId, { optionId: 'ship' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(questionId)).round).toMatchObject({
      chosenOptionId: 'ship',
      answeredWith: {
        tokenId: await liveTokenOf(memberId),
        client: { id: clientId, name: 'Claude Code' },
      },
    });
  });
});
