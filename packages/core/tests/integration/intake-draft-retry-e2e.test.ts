// REQ-34 BC-10 (ISS-455, release judge J8 on FB-123): an intake draft the model missed is tried
// again. A provider timeout or a gateway that is down is kept as a miss with another try owed, and
// the outbox delivers the item's event again with its backoff, up to three tries; past them, or
// once the delivery dies, the draft says it gave up. Driven through the real app and outbox on a
// throwaway Postgres, with the gateway a real HTTP server behind the OpenAI-wire provider, whose
// fetch gives up on a gateway that never answers: the timeout is planted for real, only shorter.
//
// @direct-test-of packages/core/src/intake/service.ts
// @direct-test-of packages/core/src/intake/read.ts
// @direct-test-of packages/core/src/db/schema-intake.ts

import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IntakeDraftResponse } from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

/** `hang`: the next intake call is never answered; `down`: every intake call is a 500. */
let mode: 'ok' | 'hang' | 'down' = 'ok';
let intakeCalls = 0;
const hung: ServerResponse[] = [];
/** The provider's own call limit here: a hung gateway is a timeout in this long, not in 60 s. */
const CALL_LIMIT_MS = 1_500;
let gateway: Server;

/** A draft the rules take: nothing to link or ask, and a feedback item's triage checklist. */
function reply(user: string): string {
  const feedback = /^The feedback /m.test(user);
  return JSON.stringify({
    fills: [],
    links: [],
    questions: [],
    nothingToAsk: 'The record settles every answer.',
    ...(feedback
      ? {
          triage: {
            route: 'issue',
            createIssue: { title: 'Referrals ignore the clinic code' },
            kind: 'bug',
            answers: {
              criterion: 'REQ-1 BC-1',
              severity: 'high',
              reproduced: 'A referral coded C1 matched a patient of clinic C2.',
            },
          },
        }
      : {}),
  });
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
      // a create asks the model more than the draft (REQ-29's area and short name): those get nothing
      const intake = text('system').includes('business analyst assistant');
      if (intake) intakeCalls += 1;
      if (intake && mode === 'hang') {
        mode = 'ok';
        hung.push(res);
        return;
      }
      if (intake && mode === 'down') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'gateway is down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-gateway', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk({ role: 'assistant', content: intake ? reply(text('user')) : '{}' }, null));
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
let token: string;

async function draftOf(ref: string): Promise<IntakeDraftResponse['draft']> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/intake-drafts/${ref}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return (res.body as unknown as IntakeDraftResponse).draft;
}

const missOf = (d: IntakeDraftResponse['draft']) => [d?.outcome, d?.code, d?.attempts, d?.retrying];

async function createRequirement(title: string): Promise<string> {
  const res = await api(token, 'POST', `/api/projects/${projectId}/requirements`, {
    title,
    reason: 'Filed in one sentence.',
    criteria: [],
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
  return (res.body as { key: string }).key;
}

/** The intake deliveries waiting on a retry, brought due now and worked, as their backoff would. */
async function retryNow(): Promise<number> {
  const due = await rows<{ n: string }>(sql`
    WITH due AS (
      UPDATE pgboss_v12.job SET start_after = now()
      WHERE name = 'outbox.intake-assistant' AND state = 'retry'
      RETURNING 1
    ) SELECT count(*)::text AS n FROM due`);
  const { wakeConsumers } = await import('../../src/outbox/worker.js');
  wakeConsumers(['intake-assistant']);
  await settleOutbox();
  return Number(due[0]?.n ?? 0);
}

/** Every intake delivery not completed, a dead one included: none once a draft is made or given up. */
async function intakeOwed(): Promise<{ state: string; later: boolean }[]> {
  return rows<{ state: string; later: boolean }>(sql`
    SELECT state, start_after > now() AS later FROM pgboss_v12.job
    WHERE state <> 'completed' AND (name = 'outbox.intake-assistant'
      OR (name = 'outbox.dead' AND data->>'consumer' = 'intake-assistant'))`);
}

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
      fetchImpl: (input, init) => {
        const limit = AbortSignal.timeout(CALL_LIMIT_MS);
        return fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit,
        });
      },
    }),
  );
  await startQueue();
  const ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await addProjectMember(projectId, ownerId, 'admin').catch(() => undefined);
  // REQ-1 BC-1: the criterion a feedback item's triage names
  const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
  const { db } = await import('../../src/db/client.js');
  const reqId = randomUUID();
  await withKernelMarker(db, async (tx) => {
    await tx.execute(
      sql`INSERT INTO requirements (id, project_id, req_seq, title, status) VALUES (${reqId}, ${projectId}, 1, 'Referral import', 'draft')`,
    );
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, tldr, reason, author_id, author_agency, proposed_at, decided_by, decided_at)
      VALUES (${reqId}, 1, 'current', ${JSON.stringify({ goal: 'A referral is matched to its patient by the clinic code.' })}::jsonb,
              'Referrals are matched by clinic code.', 'test', ${ownerId}, 'human', now(), ${ownerId}, now())`);
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE id = ${reqId}`,
    );
    await tx.execute(
      sql`INSERT INTO requirement_criteria (requirement_id, code, body, since_revision) VALUES (${reqId}, 'BC-1', 'A referral is matched by its clinic code, never by name.', 1)`,
    );
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
  for (const res of hung) res.destroy();
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
});

describe('a draft whose model call timed out is drafted again (J8 FB-123)', () => {
  it('owes the delivery again with backoff, and drafts the item on the retry', async () => {
    mode = 'hang';
    const before = intakeCalls;
    const res = await api(token, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'bug',
      title: 'A referral went to the wrong patient.',
      requirement: 'REQ-1',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
    const key = (res.body as { feedback: { key: string } }).feedback.key;
    await settleOutbox();
    const missed = await draftOf(key);
    expect([missed?.outcome, missed?.code, missed?.attempts]).toEqual([
      'failed',
      'INTAKE_MODEL_FAILED',
      1,
    ]);
    expect(missed?.detail).toMatch(/timeout|timed out|aborted/i);

    // at the base nothing was owed, so the item stayed undrafted for good
    const owed = await retryNow();
    const drafted = await draftOf(key);
    expect([drafted?.outcome, drafted?.attempts, drafted?.retrying]).toEqual(['drafted', 2, false]);
    expect(drafted?.applied?.as).toBe('suggestion');
    expect(owed).toBe(1);
    expect(missed?.retrying).toBe(true);
    expect(intakeCalls - before).toBe(2);
    expect(await intakeOwed()).toEqual([]);
  });
});

describe('a draft the model keeps missing gives up, and says so', () => {
  it('tries a gateway that is down three times, with backoff, then says it gave up', async () => {
    mode = 'down';
    const before = intakeCalls;
    const key = await createRequirement('Archive matched referrals');
    await settleOutbox();
    expect(missOf(await draftOf(key))).toEqual(['failed', 'INTAKE_MODEL_FAILED', 1, true]);
    expect(await intakeOwed()).toEqual([{ state: 'retry', later: true }]);
    expect(await retryNow()).toBe(1);
    expect(missOf(await draftOf(key))).toEqual(['failed', 'INTAKE_MODEL_FAILED', 2, true]);
    expect(await retryNow()).toBe(1);
    expect(missOf(await draftOf(key))).toEqual(['failed', 'INTAKE_MODEL_FAILED', 3, false]);
    expect(await intakeOwed()).toEqual([]);
    expect(intakeCalls - before).toBe(3);
  });

  it('says it gave up where the delivery died before its tries ran out', async () => {
    mode = 'down';
    const key = await createRequirement('Purge archived referrals');
    await settleOutbox();
    expect(missOf(await draftOf(key))).toEqual(['failed', 'INTAKE_MODEL_FAILED', 1, true]);
    // the delivery dies (taken off the queue here, as a dead one is) and its hook runs once
    const [req] = await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${projectId} AND req_seq = ${Number(key.slice(4))}`,
    );
    await rows(
      sql`DELETE FROM pgboss_v12.job WHERE name = 'outbox.intake-assistant' AND state = 'retry' RETURNING id`,
    );
    const { consumerOf } = await import('../../src/outbox/consumers.js');
    await consumerOf('requirement.created', 'intake-assistant')?.onDeadLetter?.(
      { projectId, requirementId: req?.id as string, key },
      'died',
      {
        id: 'x',
        eventId: 'x',
        createdAt: new Date(),
        attempt: 15,
        inbox: async () => undefined as never,
      },
    );
    expect(missOf(await draftOf(key))).toEqual(['failed', 'INTAKE_MODEL_FAILED', 1, false]);
  });
});
