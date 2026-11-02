// @direct-test-of packages/core/src/questions/answer-door.ts
// @direct-test-of packages/core/src/questions/void-door.ts
// @direct-test-of packages/core/src/questions/owed.ts
// @direct-test-of packages/core/src/questions/owed-to-agents.ts
// @direct-test-of packages/core/src/questions/ask.ts
// @direct-test-of packages/core/src/knowledge/service.ts
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

/** A knowledge entry of this project, by slug, of the kind and injection given. */
async function knowledge(
  slug: string,
  opts: { kind?: string; injection?: string; archived?: boolean } = {},
): Promise<void> {
  await db.execute(sql`
    INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection, archived_at)
    VALUES (${projectId}, ${slug}, ${slug}, 'The owner approves each release before the upstream MR.',
            ${opts.kind ?? 'rule'}, ${opts.injection ?? 'on_demand'},
            ${opts.archived ? sql`now()` : sql`NULL`})`);
}

describe('ISS-869: a project rule naming a person’s act admits an agent’s ask of that person', () => {
  it('outside strict, takes an agent’s ask naming a rule of the project, and keeps the rule on it', async () => {
    await knowledge('rule-owner-approves-release');
    await knowledge('release-procedure', { kind: 'workflow', injection: 'always' });
    for (const rule of ['rule-owner-approves-release', 'release-procedure']) {
      const res = await askOn(tok.agent, { rule });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await rows<{ blocker_kind: string; rule: string | null }>(
        sql`SELECT blocker_kind, rule FROM agent_questions WHERE id = ${res.body.id as string}`,
      );
      expect(row).toEqual({ blocker_kind: 'human', rule });
    }
  });

  it('refuses a rule the project does not hold as a rule, by name, and asks nothing', async () => {
    await knowledge('stack-overview', { kind: 'overview' });
    await knowledge('old-release-rule', { archived: true });
    await knowledge('a-lesson', { kind: 'lesson', injection: 'always' });
    for (const [rule, says] of [
      ['no-such-rule', 'holds no knowledge entry'],
      ['stack-overview', 'not a rule'],
      ['old-release-rule', 'archived'],
      ['a-lesson', 'not a rule'],
    ] as const) {
      const res = await askOn(tok.agent, { rule });
      expect(res.status, rule).toBe(422);
      expect(res.body.code, rule).toBe('QUESTION_RULE_UNKNOWN');
      expect(JSON.stringify(res.body), rule).toContain(says);
    }
    // a person naming a rule the project lacks is refused as well: the rule is checked for anyone
    expect((await askOn(tok.owner, { rule: 'no-such-rule' })).body.code).toBe(
      'QUESTION_RULE_UNKNOWN',
    );
    const [count] = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM agent_questions WHERE project_id = ${projectId}`,
    );
    expect(count?.n).toBe(0);
  });

  it('refuses a rule on a question asked of the master, by name', async () => {
    await knowledge('rule-owner-approves-release');
    const res = await askOn(tok.agent, {
      blockerKind: 'master_or_peer',
      rule: 'rule-owner-approves-release',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('QUESTION_SHAPE_INVALID');
    expect(JSON.stringify(res.body)).toContain('/rule');
  });

  it('names the rule way in QUESTION_AGENT_DECIDES', async () => {
    const res = await askOn(tok.agent, {});
    expect(res.body.code).toBe('QUESTION_AGENT_DECIDES');
    expect(JSON.stringify(res.body)).toContain('rule: \\"<its knowledge slug>\\"');
  });

  it('leaves a rule’s question to the person: an agent’s answer and void are refused, naming the rule', async () => {
    await knowledge('rule-owner-approves-release');
    const asked = await askOn(tok.agent, { rule: 'rule-owner-approves-release' });
    const id = asked.body.id as string;
    // the master's token answering what it asked the owner is refused, at REST and at /mcp
    const res = await answer(tok.agent, id, { optionId: 'ship', note: 'my call' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('QUESTION_OWED_BY_PERSON');
    expect(JSON.stringify(res.body)).toContain('rule-owner-approves-release');
    const mcp = await answerMcp(tok.agent, id, { optionId: 'ship', note: 'my call' });
    expect(mcp.isError).toBe(true);
    expect(mcp.text).toContain('QUESTION_OWED_BY_PERSON');
    // another agent's void is refused; the asker may still withdraw its own ask
    const other = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(projectId, other, 'admin');
    const otherTok = (
      await mintPat({ userId: other, name: 'other', projectIds: [projectId], permissions: ['*'] })
    ).plaintext;
    const voided = await api(otherTok, 'POST', `/api/questions/${id}/void`, { reason: 'mine' });
    expect(voided.status).toBe(403);
    expect(voided.body.code).toBe('QUESTION_OWED_BY_PERSON');
    expect((await stored(id)).status).toBe('open');
    const byOwner = await answer(tok.owner, id, { optionId: 'ship' });
    expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
  });
});
