// REQ-41 BC-2 (QA of 0.4.0-dev.219: 13 of 20 decisions read "No recommended answer"): a person
// question that came with none gets the assistant's suggested answer, drafted off the read path from
// the issue's product record and kept on the question, shown by the needs-me read as "by assistant",
// and sent by the same one click as an asker's recommendation. Driven through the real app on a
// throwaway Postgres, with the gateway a real HTTP server on a local port behind the OpenAI-wire
// provider: nothing is mocked inside core. A gateway that fails, declines or talks prose leaves the
// question as it was and records the named code; the asker's own recommendation is never replaced.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { needsYouDecisionsSchema } from '@forge/contracts/needs-you-decisions';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Mode = 'answer' | 'down' | 'decline' | 'prose' | 'long' | 'option' | 'invented';
let mode: Mode = 'answer';
const seen: { system: string; user: string }[] = [];
let gateway: Server;

const ANSWER = {
  answer: 'Use the clinic code printed on the referral letter, in capitals.',
  why: 'ISS-1 and REQ-1 say a referral is matched by its clinic code.',
};

function reply(mode: Mode): string {
  if (mode === 'decline')
    return JSON.stringify({ decline: 'The record does not say which account.' });
  if (mode === 'option')
    return JSON.stringify({
      option: 'move',
      why: 'REQ-1 says referrals match by clinic code, which the new format carries.',
    });
  if (mode === 'invented')
    return JSON.stringify({ option: 'rewrite-it-all', why: 'a better idea' });
  if (mode === 'prose') return 'I think you should probably use the clinic code.';
  if (mode === 'long') return JSON.stringify({ answer: 'x'.repeat(2000), why: 'too long' });
  return JSON.stringify(ANSWER);
}

function startGateway(): Promise<string> {
  gateway = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages: { role: string; content: unknown }[] };
      const text = (r: string) =>
        body.messages
          .filter((m) => m.role === r)
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n');
      seen.push({ system: text('system'), user: text('user') });
      if (mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'gateway is down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-gateway', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk({ role: 'assistant', content: reply(mode) }, null));
      res.write(
        chunk({}, 'stop', {
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    gateway.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}`),
    );
  });
}

let projectId: string;
let ownerId: string;
let token: string;
let issueId: string;
let reqId: string;
let ask: typeof import('../../src/questions/index.js').askQuestion;
let sweep: typeof import('../../src/questions/index.js').sweepQuestionSuggestions;

const decisionsPath = () => `/api/projects/${projectId}/needs-you/decisions`;
async function read() {
  const res = await api(token, 'GET', decisionsPath());
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return needsYouDecisionsSchema.parse(res.body);
}
const cardOf = async (id: string) =>
  (await read()).decisions.find((d) =>
    d.answers.some((a) => a.path === `/api/questions/${id}/answer`),
  );
async function voidQuestions(...ids: string[]) {
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  await withKernelMarker(db, (tx) =>
    tx.execute(
      sql`UPDATE agent_questions SET status = 'void' WHERE id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    ),
  );
}
const suggestionOf = async (id: string) =>
  (
    await rows<{ suggestion: Record<string, unknown> | null }>(
      sql`SELECT suggestion FROM agent_questions WHERE id = ${id}`,
    )
  )[0]?.suggestion ?? null;

const bare = (id: string, over: Record<string, unknown> = {}) =>
  ask({
    id,
    projectId,
    prompt: 'Which identifier should the referral import match on?',
    blockerKind: 'human',
    answer: { shape: 'free_text', needed: 'the identifier' },
    ...over,
  });

beforeAll(async () => {
  testEnv();
  const baseUrl = await startGateway();
  await import('../../src/index.js');
  const { register } = await import('../../src/integrations/llm/registry.js');
  const { createOpenAIProvider } = await import('../../src/integrations/llm/openai.js');
  register('openai', () =>
    createOpenAIProvider({
      baseUrl,
      apiKey: 'stub-key',
      defaultModel: 'stub-gateway',
      maxRetries: 0,
    }),
  );
  await startQueue();
  ({ askQuestion: ask, sweepQuestionSuggestions: sweep } = await import(
    '../../src/questions/index.js'
  ));
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await addProjectMember(projectId, ownerId, 'admin').catch(() => undefined);
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  reqId = randomUUID();
  await withKernelMarker(db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO requirements (id, project_id, req_seq, title, status) VALUES (${reqId}, ${projectId}, 1, 'Referral import', 'draft')`,
    );
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, tldr, reason, author_id, author_agency, proposed_at, decided_by, decided_at)
      VALUES (${reqId}, 1, 'current', ${JSON.stringify({ goal: 'A referral from a clinic is matched to its patient by the clinic code.' })}::jsonb,
              'Referrals are matched by clinic code.', 'test', ${ownerId}, 'human', now(), ${ownerId}, now())`);
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${reqId}`,
    );
    await tx.execute(
      sql`INSERT INTO requirement_criteria (requirement_id, code, body, since_revision) VALUES (${reqId}, 'BC-1', 'A referral is matched by its clinic code, never by name.', 1)`,
    );
  });
  issueId = (
    await createTestIssue(projectId, ownerId, 1, {
      status: 'open',
      createdAt: new Date(),
      requirementId: reqId,
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await closeWorld();
  await new Promise((r) => gateway.close(r));
});

describe('a question with no recommended answer (REQ-41 BC-2)', () => {
  it('is drafted off the read path and shown as the assistant’s suggestion, one click to send', async () => {
    mode = 'answer';
    const id = randomUUID();
    await bare(id, { issueId });
    await settleOutbox();
    const asked = seen.length;
    expect(asked).toBe(1);
    // it read the product record: the issue and the requirement, in its own words
    expect(seen[0]?.user).toContain('Which identifier should the referral import match on?');
    expect(seen[0]?.user).toContain('ISS-1');
    expect(seen[0]?.user).toContain('A referral is matched by its clinic code, never by name.');
    expect(await suggestionOf(id)).toMatchObject({
      outcome: 'suggested',
      round: 1,
      by: 'assistant',
      text: ANSWER.answer,
      model: 'stub-gateway',
      from: ['ISS-1', 'REQ-1'],
    });

    const card = await cardOf(id);
    expect(card?.noRecommendation).toBeNull();
    expect(card?.recommended).toMatchObject({ answerId: 'suggested', by: 'assistant' });
    expect(card?.recommended?.why).toContain(ANSWER.answer);
    expect(card?.recommended?.why).toContain('ISS-1 and REQ-1 say');
    const button = card?.answers.find((a) => a.recommended);
    expect(button).toMatchObject({
      id: 'suggested',
      act: 'question.answer',
      body: { round: 1, text: ANSWER.answer },
    });
    expect(card?.answers.some((a) => a.id === 'write' && a.needsReason)).toBe(true);

    // reading it, twice, is no model call
    await read();
    await read();
    expect(seen.length).toBe(asked);

    // the one click sends it as written
    const res = await api(token, 'POST', button?.path ?? '', button?.body ?? {});
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
    const [row] = await rows<{ status: string; steps: { answerText?: string }[] }>(
      sql`SELECT status, steps FROM agent_questions WHERE id = ${id}`,
    );
    expect(row?.status).toBe('answered');
    expect(row?.steps.at(-1)?.answerText).toBe(ANSWER.answer);
    expect(await cardOf(id)).toBeUndefined();
  });

  it('keeps the asker’s own recommendation and never calls the gateway for it', async () => {
    const before = seen.length;
    const id = randomUUID();
    await ask({
      id,
      projectId,
      issueId,
      prompt: 'Which staging URL should the run check?',
      blockerKind: 'human',
      answer: {
        shape: 'free_text',
        needed: 'the staging URL',
        recommended: 'https://staging.example.test',
      },
    });
    await settleOutbox();
    expect(seen.length).toBe(before);
    expect(await suggestionOf(id)).toBeNull();
    const card = await cardOf(id);
    expect(card?.recommended).toMatchObject({ answerId: 'recommended', by: 'asker' });
    expect(card?.answers[0]?.body).toEqual({ round: 1, text: 'https://staging.example.test' });
    await api(token, 'POST', card?.answers[0]?.path ?? '', card?.answers[0]?.body ?? {});
  });

  it('a gateway that is down leaves the question as it is and records why; the sweep tries again later', async () => {
    mode = 'down';
    const id = randomUUID();
    await bare(id, { issueId });
    await settleOutbox();
    expect(await suggestionOf(id)).toMatchObject({
      outcome: 'failed',
      code: 'QUESTION_SUGGESTION_MODEL_FAILED',
      attempts: 1,
    });
    const card = await cardOf(id);
    expect(card?.recommended).toBeNull();
    expect(card?.noRecommendation).toContain('QUESTION_SUGGESTION_MODEL_FAILED');
    expect(card?.answers.map((a) => a.id)).toEqual(['write']);
    const [open] = await rows<{ status: string }>(
      sql`SELECT status FROM agent_questions WHERE id = ${id}`,
    );
    expect(open?.status).toBe('open');

    // a moment later the sweep leaves it alone; half an hour later it tries again
    mode = 'answer';
    const calls = seen.length;
    expect(await sweep()).toEqual({ suggested: 0, failed: 0 });
    expect(seen.length).toBe(calls);
    await rows(
      sql`UPDATE agent_questions SET suggestion = jsonb_set(suggestion, '{at}', to_jsonb((now() - interval '1 hour')::text)) WHERE id = ${id}`,
    );
    expect(await sweep()).toEqual({ suggested: 1, failed: 0 });
    expect(await suggestionOf(id)).toMatchObject({ outcome: 'suggested', attempts: 2 });
    const card2 = await cardOf(id);
    expect(card2?.recommended?.by).toBe('assistant');
    await api(token, 'POST', card2?.answers[0]?.path ?? '', card2?.answers[0]?.body ?? {});
  });
});

describe('a question the assistant cannot draft an answer for (REQ-41 BC-2)', () => {
  it.each([
    ['decline', 'QUESTION_SUGGESTION_DECLINED'],
    ['prose', 'QUESTION_SUGGESTION_SHAPE'],
    ['long', 'QUESTION_SUGGESTION_SHAPE'],
  ] as const)('a model that answers %s records %s and shows no suggestion', async (m, code) => {
    mode = m;
    const id = randomUUID();
    await bare(id, { issueId });
    await settleOutbox();
    expect(await suggestionOf(id)).toMatchObject({ outcome: 'failed', code });
    const card = await cardOf(id);
    expect(card?.recommended).toBeNull();
    expect(card?.noRecommendation).toContain(code);
    // a final miss is not drafted again by the sweep
    const calls = seen.length;
    expect(await sweep()).toEqual({ suggested: 0, failed: 0 });
    expect(seen.length).toBe(calls);
    await api(token, 'POST', card?.answers[0]?.path ?? '', {
      ...card?.answers[0]?.body,
      text: 'by hand',
    });
  });

  it('a question standing on no record is refused by name and never sent to the model', async () => {
    mode = 'answer';
    const calls = seen.length;
    const id = randomUUID();
    await bare(id);
    await settleOutbox();
    expect(seen.length).toBe(calls);
    expect(await suggestionOf(id)).toMatchObject({
      outcome: 'failed',
      code: 'QUESTION_SUGGESTION_NO_RECORD',
    });
    const card = await cardOf(id);
    expect(card?.noRecommendation).toContain('QUESTION_SUGGESTION_NO_RECORD');
    await api(token, 'POST', card?.answers[0]?.path ?? '', {
      ...card?.answers[0]?.body,
      text: 'by hand',
    });
  });

  it('a sensitive question is never sent, and a kernel (machine) question is not drafted at all', async () => {
    const calls = seen.length;
    const sensitive = randomUUID();
    await bare(sensitive, { issueId, sensitive: true });
    const machine = randomUUID();
    await bare(machine, { issueId, blockerKind: 'machine' });
    await settleOutbox();
    expect(seen.length).toBe(calls);
    expect(await suggestionOf(sensitive)).toMatchObject({ code: 'QUESTION_SUGGESTION_SENSITIVE' });
    expect(await suggestionOf(machine)).toBeNull();
    await voidQuestions(sensitive, machine);
  });

  it('feedback a question stands on is read as operational feedback, and the suggestion names it', async () => {
    mode = 'answer';
    const [fb] = await rows<{ id: string }>(sql`
      INSERT INTO feedback (project_id, fb_seq, kind, title, body, where_seen, status, reported_by, reporter_agency)
      VALUES (${projectId}, 1, 'bug', 'Import drops two referrals', 'Two referrals vanish after the nightly import.', 'The import', 'new', ${ownerId}, 'human')
      RETURNING id`);
    const id = randomUUID();
    await bare(id, { feedbackId: fb?.id });
    await settleOutbox();
    const last = seen.at(-1);
    expect(last?.user).toContain('Import drops two referrals');
    expect((await suggestionOf(id))?.from).toEqual(['FB-1']);
    await voidQuestions(id);
  });

  it('the backfill drafts the open questions without one a few at a time, once each', async () => {
    mode = 'answer';
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    mode = 'down';
    for (const id of ids) await bare(id, { issueId });
    await settleOutbox();
    // asked before the rule existed: no record of any attempt
    await rows(
      sql`UPDATE agent_questions SET suggestion = NULL WHERE id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    mode = 'answer';
    const calls = seen.length;
    expect(await sweep(3)).toEqual({ suggested: 3, failed: 0 });
    expect(seen.length - calls).toBe(3);
    expect(await sweep(3)).toEqual({ suggested: 2, failed: 0 });
    expect(await sweep(3)).toEqual({ suggested: 0, failed: 0 });
    expect(seen.length - calls).toBe(5);
    await voidQuestions(...ids);
  });
});

describe('a choice round with no offered recommendation, and the decisions record (REQ-41 BC-2)', () => {
  const option = (id: string, label: string) => ({
    id,
    label,
    authority: 'writer' as const,
    bindsTo: 'session' as const,
    executedBy: 'agent' as const,
  });
  async function unrecommendedChoice() {
    const id = randomUUID();
    await ask({
      id,
      projectId,
      issueId,
      prompt: 'Keep the old import format or move to the new one?',
      blockerKind: 'human',
      answer: {
        shape: 'choice',
        options: [option('keep', 'Keep the old format'), option('move', 'Move to the new one')],
        recommendedOptionId: 'keep',
      },
    });
    await settleOutbox();
    // a row older than the rule: its recommended option is not one it offers
    await rows(
      sql`UPDATE agent_questions SET steps = jsonb_set(steps, '{0,recommendedOptionId}', '"gone"') WHERE id = ${id}`,
    );
    return id;
  }

  it('picks one of the offered options with a why, and the one click sends that option', async () => {
    mode = 'option';
    const id = await unrecommendedChoice();
    expect(await sweep(1)).toEqual({ suggested: 1, failed: 0 });
    expect(await suggestionOf(id)).toMatchObject({
      outcome: 'suggested',
      optionId: 'move',
      text: 'Move to the new one',
    });
    const card = await cardOf(id);
    expect(card?.recommended).toMatchObject({ answerId: 'move', by: 'assistant' });
    expect(card?.recommended?.why).toContain('REQ-1 says referrals match');
    expect(card?.answers.map((a) => [a.id, a.recommended])).toEqual([
      ['move', true],
      ['keep', false],
    ]);
    const button = card?.answers[0];
    expect(button?.body).toEqual({ round: 1, optionId: 'move' });
    const res = await api(token, 'POST', button?.path ?? '', button?.body ?? {});
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
  });

  it('never invents an option: an id the round does not offer is refused by name and nothing is shown', async () => {
    mode = 'invented';
    const id = await unrecommendedChoice();
    expect(await sweep(1)).toEqual({ suggested: 0, failed: 1 });
    expect(await suggestionOf(id)).toMatchObject({
      outcome: 'failed',
      code: 'QUESTION_SUGGESTION_SHAPE',
    });
    const card = await cardOf(id);
    expect(card?.recommended).toBeNull();
    expect(card?.noRecommendation).toContain('QUESTION_SUGGESTION_SHAPE');
    expect(card?.answers.map((a) => a.id).sort()).toEqual(['keep', 'move']);
    await voidQuestions(id);
  });

  it('an asker’s offered recommendation on a choice round is never redrafted', async () => {
    mode = 'option';
    const calls = seen.length;
    const id = randomUUID();
    await ask({
      id,
      projectId,
      issueId,
      prompt: 'Keep or move?',
      blockerKind: 'human',
      answer: {
        shape: 'choice',
        options: [option('keep', 'Keep'), option('move', 'Move')],
        recommendedOptionId: 'keep',
      },
    });
    await settleOutbox();
    expect(await sweep()).toEqual({ suggested: 0, failed: 0 });
    expect(seen.length).toBe(calls);
    await voidQuestions(id);
  });

  it('reads the requirement’s decisions record, those on the requirement and on its issues', async () => {
    mode = 'answer';
    await rows(
      sql`INSERT INTO comments (requirement_id, author_id, body, intent, decision) VALUES (${reqId}, ${ownerId}, 'Decision recorded.', 'decision', ${JSON.stringify({ decision: 'clinic codes are always written in capitals', reason: 'the letters are printed that way' })}::jsonb)`,
    );
    await rows(
      sql`INSERT INTO comments (issue_id, author_id, body, intent, decision) VALUES (${issueId}, ${ownerId}, 'Decision recorded.', 'decision', ${JSON.stringify({ decision: 'the import skips referrals older than a year', reason: 'older ones are archived' })}::jsonb)`,
    );
    await rows(
      sql`INSERT INTO comments (requirement_id, author_id, body, intent) VALUES (${reqId}, ${ownerId}, 'Just a note, not a decision.', 'note')`,
    );
    const id = randomUUID();
    await bare(id, { issueId });
    await settleOutbox();
    const read = seen.at(-1)?.user ?? '';
    expect(read).toContain(
      'Decision recorded: clinic codes are always written in capitals (because the letters are printed that way)',
    );
    expect(read).toContain(
      'Decision recorded: the import skips referrals older than a year (because older ones are archived)',
    );
    expect(read).not.toContain('Just a note');
    await voidQuestions(id);
  });
});
