// REQ-34 BC-4, BC-10..BC-16 (ISS-455): a requirement or a feedback item written in one sentence is
// drafted by the intake assistant the moment it is created, with no chat opened. Driven through the
// real app on a throwaway Postgres, with the gateway a real HTTP server on a local port behind the
// OpenAI-wire provider: nothing is mocked inside core. The draft reads requirements, workflows,
// feedback and releases only; it names duplicates, conflicts, affected workflows and related
// feedback, each linked; it fills the requirement's empty draft with each answer stated as an
// assumption naming its source, or proposes the feedback item's triage checklist; and it asks at
// most three questions, each with a recommended answer and what each choice changes, or says it has
// nothing to ask. A miss the model makes, and the retry that follows it, are
// intake-draft-retry-e2e.test.ts's.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IntakeDraftResponse } from '@forge/contracts/intake-drafts';
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

type Mode = 'requirement' | 'feedback' | 'unchecked' | 'nothing' | 'four';
let mode: Mode = 'requirement';
const seen: { system: string; user: string }[] = [];
let gateway: Server;

const ISSUE_TITLE = 'Zebra crossing rewrite of the importer';

const question = (n: number) => ({
  prompt: `Does a referral with no clinic code wait or bounce (${n})?`,
  changes: 'outcome',
  options: [
    { id: 'wait', label: 'It waits', effect: 'A clerk matches it by hand' },
    { id: 'bounce', label: 'It bounces', effect: 'The clinic is asked to resend it' },
  ],
  recommended: 'wait',
});

/** The item's own title, as the intake call was sent it: what each link's itemQuote quotes. */
const titleIn = (user: string) =>
  /^The (?:requirement|feedback) \S+:\n\s+Title: (.+)$/m.exec(user)?.[1] ?? '';

function reply(m: Mode, user: string): string {
  const itemQuote = titleIn(user).replace(/\.$/, '');
  const requirementDraft = {
    fills: [
      { field: 'summary', value: 'Clinic referrals reach the right patient.', source: 'REQ-1' },
      { field: 'goal', value: 'No referral is matched to the wrong patient.', source: 'REQ-1' },
      { field: 'persona', value: 'Referral clerk', source: 'workflow:referral' },
      { field: 'criterion', value: 'A referral is matched by its clinic code.', source: 'REQ-1' },
    ],
    links: [
      {
        relation: 'duplicate',
        ref: 'REQ-1',
        why: 'Both match referrals by clinic code.',
        basis: 'Referrals are matched by clinic code',
        itemQuote,
      },
      {
        relation: 'affected_workflow',
        ref: 'workflow:referral',
        why: 'Its match step changes.',
        basis: 'Match the referral',
        itemQuote,
      },
    ],
    questions: [question(1)],
    nothingToAsk: null,
  };
  if (m === 'requirement') return JSON.stringify(requirementDraft);
  if (m === 'nothing') {
    return JSON.stringify({
      ...requirementDraft,
      questions: [],
      nothingToAsk: 'The record settles every answer.',
    });
  }
  if (m === 'four') {
    return JSON.stringify({
      ...requirementDraft,
      questions: [question(1), question(2), question(3), question(4)],
    });
  }
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
  return JSON.stringify({
    fills: [
      { field: 'kind', value: 'bug', source: 'FB-1' },
      { field: 'requirement', value: 'REQ-1', source: 'REQ-1' },
      { field: 'criterion', value: 'BC-1', source: 'REQ-1' },
      { field: 'route', value: 'issue', source: 'REQ-1' },
    ],
    links: [
      {
        relation: 'conflict',
        ref: 'REQ-1',
        why: 'REQ-1 BC-1 says the code decides.',
        basis: 'A referral is matched by its clinic code',
        itemQuote,
      },
      {
        relation: 'affected_workflow',
        ref: 'workflow:referral',
        why: 'The match step.',
        basis: 'Match the referral',
        itemQuote,
      },
    ],
    questions: [],
    nothingToAsk: 'The record settles the triage.',
    // the triage the accept would refuse: no checklist answers (Feedback lifecycle r14 triage-check)
    triage: m === 'unchecked' ? { route: 'issue', kind: 'bug' } : triage,
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
      // a create asks the model more than the draft (REQ-29 proposes an area and a short name): only
      // the intake assistant's call is recorded and drafted, and any other is answered with nothing
      const system = text('system');
      const intake = system.includes('business analyst assistant');
      if (intake) seen.push({ system, user: text('user') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-gateway', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(
        chunk({ role: 'assistant', content: intake ? reply(mode, text('user')) : '{}' }, null),
      );
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

// each test file has a database of its own, so every conversation in it was opened by this file
const conversations = async () =>
  Number(
    (await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM conversations`))[0]?.n ?? 0,
  );

async function draftOf(ref: string): Promise<IntakeDraftResponse['draft']> {
  const res = await api(token, 'GET', `/api/projects/${projectId}/intake-drafts/${ref}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
  return (res.body as unknown as IntakeDraftResponse).draft;
}

async function createRequirement(
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await api(token, 'POST', `/api/projects/${projectId}/requirements`, {
    title,
    reason: 'Filed in one sentence.',
    criteria: [],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
  return (res.body as { key: string }).key;
}

async function requirementOf(key: string) {
  const res = await api(token, 'GET', `/api/projects/${projectId}/requirements/${key}`);
  expect(res.status).toBe(200);
  return res.body as {
    revisions: {
      revision: number;
      tldr: string | null;
      spec: Record<string, unknown>;
      criteria: { code: string; body: string }[];
    }[];
  };
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
    }),
  );
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await addProjectMember(projectId, ownerId, 'admin').catch(() => undefined);
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
  // an issue the draft must never read
  const issue = await createTestIssue(projectId, ownerId, 1, {
    status: 'open',
    createdAt: new Date(),
  });
  await db.execute(sql`UPDATE issues SET title = ${ISSUE_TITLE} WHERE id = ${issue.id}`);
}, 120_000);

afterAll(async () => {
  await closeWorld();
  await new Promise((r) => gateway.close(r));
});

describe('a requirement written in one sentence is drafted on create, with no chat (BC-4, BC-10)', () => {
  it('fills the empty draft, each fill an assumption naming its source, and links what it duplicates and affects', async () => {
    mode = 'requirement';
    const before = seen.length;
    const key = await createRequirement('Match referrals to patients');
    await settleOutbox();
    expect(seen.length - before).toBe(1);
    expect(await conversations()).toBe(0);

    const req = await requirementOf(key);
    const r1 = req.revisions.find((r) => r.revision === 1);
    expect(r1?.tldr).toBe('Clinic referrals reach the right patient.');
    expect(r1?.spec.goal).toBe('No referral is matched to the wrong patient.');
    expect(r1?.spec.personas).toEqual(['Referral clerk']);
    const filled = (r1?.spec.assumptions ?? []) as { text: string; source: string }[];
    expect(filled.map((a) => [a.text, a.source])).toEqual([
      ['Summary: Clinic referrals reach the right patient.', 'REQ-1'],
      ['Goal: No referral is matched to the wrong patient.', 'REQ-1'],
      ['Persona: Referral clerk', 'workflow:referral'],
      ['Criterion: A referral is matched by its clinic code.', 'REQ-1'],
    ]);
    expect(r1?.criteria.map((c) => c.body)).toEqual(['A referral is matched by its clinic code.']);

    const draft = await draftOf(key);
    expect(draft?.outcome).toBe('drafted');
    expect(draft?.links.map((l) => [l.relation, l.ref.kind, l.ref.key])).toEqual([
      ['duplicate', 'requirement', 'REQ-1'],
      ['affected_workflow', 'workflow', 'referral'],
    ]);
    expect(draft?.questions).toHaveLength(1);
    expect(draft?.questions[0]?.recommended).toBe('wait');
    expect(draft?.questions[0]?.options.map((o) => o.effect)).toEqual([
      'A clerk matches it by hand',
      'The clinic is asked to resend it',
    ]);
    expect(draft?.nothingToAsk).toBeNull();
    expect(draft?.applied).toEqual({
      as: 'revision',
      revision: 1,
      fields: ['summary', 'goal', 'persona', 'criterion'],
    });
  });

  it('read requirements, workflows, feedback and releases, and never the issue', async () => {
    const last = seen.at(-1);
    expect(last?.user).toContain('REQ-1 (agreed): Referral import');
    expect(last?.user).toContain('BC-1: A referral is matched by its clinic code, never by name.');
    expect(last?.user).toContain('workflow:referral (Referral intake');
    expect(last?.user).not.toContain(ISSUE_TITLE);
    expect(last?.user).not.toMatch(/ISS-1\b/);
    const draft = await draftOf('REQ-2');
    expect(Object.keys(draft?.read ?? {}).sort()).toEqual([
      'feedback',
      'releases',
      'requirements',
      'workflows',
    ]);
  });

  it('never replaces what the author already wrote', async () => {
    mode = 'requirement';
    const key = await createRequirement('Match referrals by code', {
      tldr: 'The author’s own summary.',
    });
    await settleOutbox();
    const r1 = (await requirementOf(key)).revisions.find((r) => r.revision === 1);
    expect(r1?.tldr).toBe('The author’s own summary.');
    expect((await draftOf(key))?.applied).toEqual({
      as: 'revision',
      revision: 1,
      fields: ['goal', 'persona', 'criterion'],
    });
  });

  it('says it has nothing to ask and asks nothing (BC-16)', async () => {
    mode = 'nothing';
    const key = await createRequirement('Book the referral once matched');
    await settleOutbox();
    const draft = await draftOf(key);
    expect(draft?.questions).toEqual([]);
    expect(draft?.nothingToAsk).toBe('The record settles every answer.');
  });

  it('keeps a draft that asks four questions as a named miss and leaves the requirement as written (BC-14)', async () => {
    mode = 'four';
    const before = seen.length;
    const key = await createRequirement('Remind the clinic of unmatched referrals');
    await settleOutbox();
    expect(seen.length - before).toBe(2);
    expect(seen.at(-1)?.user).toContain('That was refused: questions: Too big');
    const draft = await draftOf(key);
    expect([draft?.outcome, draft?.code]).toEqual(['failed', 'INTAKE_SHAPE']);
    const r1 = (await requirementOf(key)).revisions.find((r) => r.revision === 1);
    expect(r1?.tldr ?? null).toBeNull();
  });
});

describe('a feedback item filed in one sentence is drafted on filing, with no chat (BC-10)', () => {
  it('proposes its triage checklist as the BA assistant and keeps the draft with sources and links', async () => {
    mode = 'feedback';
    const res = await api(token, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'bug',
      title: 'A referral went to the wrong patient.',
      requirement: 'REQ-1',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
    await settleOutbox();
    expect(await conversations()).toBe(0);
    const sugg = await rows<{
      kind: string;
      producer_kind: string;
      status: string;
      payload: { route: string };
    }>(
      sql`SELECT s.kind, s.producer_kind, s.status, s.payload FROM suggestions s JOIN feedback f ON f.id = s.feedback_id WHERE f.project_id = ${projectId} AND f.fb_seq = 1`,
    );
    expect(sugg.map((s) => [s.kind, s.producer_kind, s.status, s.payload.route])).toEqual([
      ['feedback_triage', 'ba_assistant', 'proposed', 'issue'],
    ]);
    const draft = await draftOf('FB-1');
    expect(draft?.assumptions.map((a) => [a.field, a.value, a.source.key])).toEqual([
      ['kind', 'bug', 'FB-1'],
      ['requirement', 'REQ-1', 'REQ-1'],
      ['criterion', 'BC-1', 'REQ-1'],
      ['route', 'issue', 'REQ-1'],
    ]);
    expect(draft?.links.map((l) => [l.relation, l.ref.key])).toEqual([
      ['conflict', 'REQ-1'],
      ['affected_workflow', 'referral'],
    ]);
    expect(draft?.applied?.as).toBe('suggestion');
    expect(seen.at(-1)?.system).toContain('"triage"');
  });

  it('refuses a triage its accept would refuse, without the checklist answers, and proposes none', async () => {
    mode = 'unchecked';
    const before = seen.length;
    const res = await api(token, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'bug',
      title: 'A second referral went to the wrong patient.',
      requirement: 'REQ-1',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201);
    const key = (res.body as { feedback: { key: string } }).feedback.key;
    await settleOutbox();
    expect(seen.length - before).toBe(2);
    expect(seen.at(-1)?.user).toMatch(/That was refused: triage: answers: /);
    const draft = await draftOf(key);
    expect([draft?.outcome, draft?.code]).toEqual(['failed', 'INTAKE_SHAPE']);
    const sugg = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM suggestions s JOIN feedback f ON f.id = s.feedback_id WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(key.slice(3))}`,
    );
    expect(sugg[0]?.n).toBe('0');
  });
});

describe('the draft read', () => {
  it('refuses a ref that names no requirement or feedback item, by name', async () => {
    const res = await api(token, 'GET', `/api/projects/${projectId}/intake-drafts/ISS-1`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('INTAKE_REF_INVALID');
    const missing = await api(token, 'GET', `/api/projects/${projectId}/intake-drafts/REQ-99`);
    expect(missing.status).toBe(404);
  });
});
