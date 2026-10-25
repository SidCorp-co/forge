/**
 * The world the value check's e2e files run in (REQ-65, ISS-690): the real app on a throwaway
 * Postgres, the model a real HTTP server on a local port behind the OpenAI-wire provider, answering
 * by the word the item's title opens with (Accept:, Refuse:, Merge:, Alternative:, Held:, Wrongblock:,
 * Nomeasure:, Criterion:), and one agreed requirement, REQ-1, with its workflow, to check against.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IntakeDraftResponse, IntakeDraftView } from '@forge/contracts/intake-drafts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect } from 'vitest';
import { api, type Body, userToken } from './api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from './ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from './factories.js';

export const seen: { system: string; user: string }[] = [];
let gateway: Server;

export const RECOMMENDED = {
  id: 'weekly',
  label: 'Wrong matches per week',
  effect: 'Counted weekly',
};
const measureQuestion = (blocks: string | null = null) => ({
  prompt: 'How is a better match counted?',
  changes: 'outcome',
  options: [
    RECOMMENDED,
    { id: 'monthly', label: 'Complaints per month', effect: 'Counted monthly' },
  ],
  recommended: 'weekly',
  blocks,
});
export const PROBLEM_QUESTION = {
  prompt: 'Whose work does this change?',
  changes: 'scope',
  options: [
    { id: 'clerk', label: 'The referral clerk', effect: 'Scoped to intake' },
    { id: 'doctor', label: 'The doctor', effect: 'Scoped to the visit' },
  ],
  recommended: 'clerk',
  blocks: 'problem',
};
export const REFUSE_REASON = 'A purple header gives nobody anything they asked for.';

const keyIn = (user: string) => /^The (?:requirement|feedback) (\S+):$/m.exec(user)?.[1] ?? '';
const titleIn = (user: string) =>
  /^The (?:requirement|feedback) \S+:\n\s+Title: (.+)$/m.exec(user)?.[1] ?? '';

/** The model's draft for the item it is sent, by the word its title opens with. */
function reply(user: string, retried: boolean): Body {
  const key = keyIn(user);
  const title = titleIn(user);
  const said = title.replace(/^\w+: /, '').replace(/\.$/, '');
  const feedback = key.startsWith('FB-');
  const base = {
    fills: [],
    links: [] as Body[],
    notAffected: [{ ref: 'workflow:referral', why: 'Its match step stays as it is.' }],
    questions: [measureQuestion()] as Body[],
    nothingToAsk: null as string | null,
    value: {
      who: { value: 'Referral clerk', source: 'workflow:referral' },
      improves: { value: 'Fewer referrals reach the wrong patient', source: key },
      measured: { value: 'Counted weekly', source: 'question:1' },
      exists: null as Body | null,
      outcome: { kind: 'accept' } as Body | null,
    },
  };
  const triage = {
    route: 'issue',
    createIssue: { title: 'Referrals ignore the clinic code' },
    kind: 'bug',
    answers: {
      criterion: 'REQ-1 BC-1',
      severity: 'high',
      reproduced: 'A referral coded C1 matched a patient of clinic C2.',
    },
  };
  const conflict = {
    relation: 'conflict',
    ref: 'REQ-1',
    why: 'REQ-1 BC-1 says the code decides.',
    basis: 'A referral is matched by its clinic code',
    itemQuote: said,
  };
  if (title.startsWith('Refuse:')) {
    const out = {
      ...base,
      value: { ...base.value, improves: null, outcome: { kind: 'refuse', reason: REFUSE_REASON } },
    };
    return feedback ? { ...out, triage: { route: 'decline', kind: 'idea' } } : out;
  }
  if (title.startsWith('Merge:')) {
    return {
      ...base,
      links: [
        {
          relation: 'duplicate',
          ref: 'REQ-1',
          why: 'Both match referrals by clinic code.',
          basis: 'Referrals are matched by clinic code',
          itemQuote: said,
        },
      ],
      value: {
        ...base.value,
        exists: { ref: 'REQ-1', why: 'REQ-1 already matches by clinic code.' },
        outcome: { kind: 'merge', into: 'REQ-1', why: 'It asks what REQ-1 already holds.' },
      },
    };
  }
  if (title.startsWith('Alternative:')) {
    return {
      ...base,
      value: {
        ...base.value,
        outcome: {
          kind: 'alternative',
          instead: 'Show the clinic code on the referral list.',
          ref: 'REQ-1',
        },
      },
    };
  }
  if (title.startsWith('Held:') && !user.includes('Answered:')) {
    return {
      ...base,
      questions: [measureQuestion(), PROBLEM_QUESTION],
      value: { ...base.value, who: null, outcome: null },
    };
  }
  if (title.startsWith('Held:')) {
    return { ...base, value: { ...base.value, who: { value: 'The referral clerk', source: key } } };
  }
  if (title.startsWith('Wrongblock:') && !retried) {
    // a question that blocks on the problem the check already states
    return {
      ...base,
      questions: [measureQuestion('problem')],
      value: { ...base.value, outcome: null },
    };
  }
  if (title.startsWith('Nomeasure:')) {
    return { ...base, value: { ...base.value, measured: null } };
  }
  if (title.startsWith('Criterion:')) {
    // a question blocking on a criterion with no conflict link that quotes one
    return {
      ...base,
      links: retried ? [conflict] : [],
      questions: [{ ...measureQuestion('criterion'), prompt: 'Does it still match by the code?' }],
      value: {
        ...base.value,
        measured: { value: 'Wrong matches per week', source: key },
        outcome: null,
      },
    };
  }
  return feedback ? { ...base, links: [conflict], triage } : base;
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
      const system = text('system');
      const intake = system.includes('business analyst assistant');
      const user = text('user');
      if (intake) seen.push({ system, user });
      const content = intake
        ? JSON.stringify(reply(user, user.includes('That was refused')))
        : '{}';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-gateway', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk({ role: 'assistant', content }, null));
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

/** The project, its owner and a viewer, set once the world is up. */
export const world = { projectId: '', ownerId: '', owner: '', viewer: '' };

export async function draftOf(ref: string, as = world.owner): Promise<IntakeDraftView | null> {
  const res = await api(as, 'GET', `/api/projects/${world.projectId}/intake-drafts/${ref}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return (res.body as unknown as IntakeDraftResponse).draft;
}

export async function create(title: string, extra: Body = {}): Promise<string> {
  const res = await api(world.owner, 'POST', `/api/projects/${world.projectId}/requirements`, {
    title,
    reason: 'Filed in one sentence.',
    criteria: [],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
  await settleOutbox();
  return (res.body as { key: string }).key;
}

export async function statusOf(key: string): Promise<string> {
  const res = await api(world.owner, 'GET', `/api/projects/${world.projectId}/requirements/${key}`);
  return (res.body as { status: string }).status;
}

/** Starts the app over a stub model gateway with one agreed requirement and its workflow to check against. */
export function useValueCheckWorld(): void {
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
    const ownerId = (await createTestUser({ verified: true })).id;
    const projectId = (await createTestProject(ownerId)).id;
    world.ownerId = ownerId;
    world.projectId = projectId;
    world.owner = await userToken(ownerId);
    await addProjectMember(projectId, ownerId, 'admin').catch(() => undefined);
    const viewerId = (await createTestUser({ verified: true })).id;
    await addProjectMember(projectId, viewerId, 'viewer');
    world.viewer = await userToken(viewerId);
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
      await tx.execute(sql`
      INSERT INTO project_workflows (project_id, flow, kind, revision, written_by_user, document)
      VALUES (${projectId}, 'referral', 'flow', 1, ${ownerId}, ${JSON.stringify({
        title: 'Referral intake',
        summary: 'A referral arrives, is matched to its patient and booked.',
        steps: [{ id: 'match', node: { label: 'Match the referral' } }],
      })}::jsonb)`);
    });
  }, 120_000);

  afterAll(async () => {
    await closeWorld();
    await new Promise((r) => gateway.close(r));
  });
}
