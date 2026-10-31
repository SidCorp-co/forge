// @direct-test-of packages/core/src/questions/answer-door.ts
// @direct-test-of packages/core/src/questions/void-door.ts
// @direct-test-of packages/core/src/questions/owed.ts
// @direct-test-of packages/core/src/questions/owed-to-agents.ts
// @direct-test-of packages/core/src/questions/ask.ts
// @direct-test-of packages/core/src/requirements/clarity.ts
/**
 * REQ-79 BC-14 (owner, 2026-10-31): a question owed to a person in a class the agent may decide is
 * refused by name; an agent holding the permission answers or voids any question, recording its
 * decision. Outside `strict`, and under it for a question its asker did not judge serious (BC-13),
 * an agent's token answers a question a person was asked, with its reason, recorded as an agent's;
 * one marked serious on a strict project stays a person's. An agent asking a person what it may
 * decide is refused by name, and a decision core asks on a requirement is owed to the project's
 * master unless the project is strict. Against real Postgres, over REST and `/mcp`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { askQuestion, questionsOwedToAgents } from '../../src/questions/index.js';
import { withAskedQuestions } from '../../src/requirements/clarity.js';
import { api } from '../helpers/api.js';
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

let projectId = '';
let ownerId = '';
let agentId = '';
const tok = { owner: '', agent: '' };

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
  agentId = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(projectId, agentId, 'admin');
  const mint = async (userId: string, name: string) =>
    (await mintPat({ userId, name, projectIds: [projectId], permissions: ['*'] })).plaintext;
  tok.owner = await mint(ownerId, 'owner-cli');
  tok.agent = await mint(agentId, 'agent-own');
});

const strict = () => declareControls(projectId, ownerId, { gates: { profile: 'strict' } });

/** An open question a person was asked, free text, serious where said. */
async function personAsked(opts: { serious?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await askQuestion({
    id,
    projectId,
    askedBy: ownerId,
    prompt: 'Which flag guards the tour?',
    blockerKind: 'human',
    ...(opts.serious ? { serious: true } : {}),
    answer: { shape: 'free_text', needed: 'the flag', recommended: 'tours.v2' },
  });
  return id;
}

const answer = (token: string, questionId: string, body: Json) =>
  api(token, 'POST', `/api/questions/${questionId}/answer`, { round: 1, ...body });

async function answerMcp(token: string, questionId: string, body: Json) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'forge_questions',
        arguments: { action: 'answer', projectId, questionId, round: 1, ...body },
      },
    },
    { accept: 'application/json, text/event-stream' },
  );
  const result = res.body.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

/** The question as stored, with the agency of the kernel move that ended it. */
async function stored(questionId: string) {
  const [row] = await rows<{
    status: string;
    blocker_kind: string;
    serious: boolean;
    steps: Json[];
  }>(
    sql`SELECT status, blocker_kind, serious, steps FROM agent_questions WHERE id = ${questionId}`,
  );
  const [move] = await rows<{ actor_id: string; actor_agency: string }>(
    sql`SELECT actor_id, actor_agency FROM kernel_transitions
        WHERE entity_id = ${questionId} AND to_status IN ('answered', 'void')`,
  );
  return { ...row, round: row?.steps.at(-1) ?? {}, move };
}

describe('REQ-79 BC-14: an agent holding the permission answers a question a person was asked', () => {
  it('outside strict, answers it with its reason, recorded as an agent’s, at either door', async () => {
    const viaRest = await personAsked();
    const res = await answer(tok.agent, viaRest, {
      text: 'tours.v2',
      note: 'tours.v2 is the flag the tour code reads',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = await stored(viaRest);
    expect(done.status).toBe('answered');
    expect(done.round).toMatchObject({ answerText: 'tours.v2', answeredBy: agentId });
    expect(JSON.stringify(done.round)).toContain('tours.v2 is the flag the tour code reads');
    expect(done.move).toEqual({ actor_id: agentId, actor_agency: 'agent' });

    const viaMcp = await personAsked();
    const mcp = await answerMcp(tok.agent, viaMcp, { text: 'tours.v2', note: 'the code reads it' });
    expect(mcp.isError, mcp.text).toBe(false);
    expect((await stored(viaMcp)).status).toBe('answered');
  });

  it('refuses an agent’s answer that gives no reason, by name, and leaves it open', async () => {
    const questionId = await personAsked();
    const res = await answer(tok.agent, questionId, { text: 'tours.v2' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('QUESTION_AGENT_REASON_REQUIRED');
    const blank = await answer(tok.agent, questionId, { text: 'tours.v2', note: '   ' });
    expect(blank.body.code).toBe('QUESTION_AGENT_REASON_REQUIRED');
    expect((await stored(questionId)).status).toBe('open');
  });

  it('under strict, answers one its asker did not judge serious', async () => {
    await strict();
    const questionId = await personAsked();
    const res = await answer(tok.agent, questionId, { text: 'tours.v2', note: 'not serious' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('under strict, leaves a serious one to the person, by name, at either door', async () => {
    await strict();
    const questionId = await personAsked({ serious: true });
    const res = await answer(tok.agent, questionId, { text: 'tours.v2', note: 'my call' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUESTION_OWED_BY_PERSON');
    expect(JSON.stringify(res.body)).toContain('serious');
    const mcp = await answerMcp(tok.agent, questionId, { text: 'tours.v2', note: 'my call' });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain('QUESTION_OWED_BY_PERSON');
    expect((await stored(questionId)).status).toBe('open');
    const byPerson = await answer(tok.owner, questionId, { text: 'tours.v2' });
    expect(byPerson.status, JSON.stringify(byPerson.body)).toBe(200);
  });
});

describe('REQ-79 BC-14: an agent holding the permission voids a question', () => {
  it('outside strict, voids one a person was asked, recorded as an agent’s', async () => {
    const questionId = await personAsked();
    const res = await api(tok.agent, 'POST', `/api/questions/${questionId}/void`, {
      reason: 'decided it: the code reads tours.v2',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await stored(questionId)).move).toEqual({ actor_id: agentId, actor_agency: 'agent' });
  });

  it('under strict, leaves a serious one to the person, by name', async () => {
    await strict();
    const questionId = await personAsked({ serious: true });
    const res = await api(tok.agent, 'POST', `/api/questions/${questionId}/void`, {
      reason: 'decided it myself',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUESTION_OWED_BY_PERSON');
    expect((await stored(questionId)).status).toBe('open');
  });
});

const ASK = {
  prompt: 'Ship the tour behind tours.v2?',
  options: [
    { id: 'ship', label: 'Ship it', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
    { id: 'hold', label: 'Hold it', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
  ],
  recommendedOptionId: 'ship',
};

let reqSeq = 100;

async function askOn(token: string, body: Json) {
  reqSeq += 1;
  const requirement = await createTestRequirement(projectId, reqSeq, 'Tours guard behind a flag');
  return api(token, 'POST', '/api/questions', {
    projectId,
    ...ASK,
    about: { requirement: requirement.key },
    ...body,
  });
}

describe('REQ-79 BC-14: an agent asking a person what it may decide is refused by name', () => {
  it('outside strict, refuses an agent’s ask of a person, serious or not, and takes one of the master', async () => {
    const plain = await askOn(tok.agent, {});
    expect(plain.status).toBe(422);
    expect(plain.body.code).toBe('QUESTION_AGENT_DECIDES');
    expect(JSON.stringify(plain.body)).toContain('master_or_peer');
    const serious = await askOn(tok.agent, { blockerKind: 'human', serious: true });
    expect(serious.body.code).toBe('QUESTION_AGENT_DECIDES');
    const ofMaster = await askOn(tok.agent, { blockerKind: 'master_or_peer' });
    expect(ofMaster.status, JSON.stringify(ofMaster.body)).toBe(201);
  });

  it('under strict, takes a serious ask of a person and refuses one not serious', async () => {
    await strict();
    const serious = await askOn(tok.agent, { serious: true });
    expect(serious.status, JSON.stringify(serious.body)).toBe(201);
    const kept = await stored(serious.body.id as string);
    expect(kept).toMatchObject({ blocker_kind: 'human', serious: true });
    const plain = await askOn(tok.agent, {});
    expect(plain.body.code).toBe('QUESTION_AGENT_DECIDES');
  });

  it('takes a person’s ask of a person on any project', async () => {
    const res = await askOn(tok.owner, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stored(res.body.id as string)).toMatchObject({ blocker_kind: 'human' });
  });
});

describe('REQ-79 BC-13: a requirement’s open business question is owed by the project’s control', () => {
  const openQuestion = async () => {
    const requirement = await createTestRequirement(projectId, 9, 'Tours guard behind a flag');
    const written = await db.transaction((tx) =>
      withAskedQuestions(tx, {
        projectId,
        requirementId: requirement.id,
        spec: {
          openQuestions: [
            { question: 'Does the tour show to guests?', whoAnswers: 'the owner', blocking: true },
          ],
        } as never,
      }),
    );
    if (!('spec' in written)) throw new Error(JSON.stringify(written));
    return (written.spec.openQuestions?.[0]?.questionId ?? '') as string;
  };

  it('outside strict, is owed to the master, never parked on a person', async () => {
    const id = await openQuestion();
    expect(await stored(id)).toMatchObject({
      blocker_kind: 'master_or_peer',
      serious: true,
    });
    // and the master's pass is where it is owed, since no person's Needs you lists it
    expect((await questionsOwedToAgents(projectId)).map((q) => q.id)).toContain(id);
  });

  it('under strict, is a person’s: product direction is serious', async () => {
    await strict();
    const id = await openQuestion();
    expect(await stored(id)).toMatchObject({
      blocker_kind: 'human',
      serious: true,
    });
    expect((await questionsOwedToAgents(projectId)).map((q) => q.id)).not.toContain(id);
  });
});
