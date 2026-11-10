// REQ-34 BC-21, ISS-456 criterion 4: a step that asks the author something reaches them as a
// notification. A question asked of a requirement rings its author's bell when it is asked, as one row
// per requirement, and never the bell of whoever asked it; answering it resolves the row. Judge run
// ad038e31 on dev.649: REQ-95's create asked its author "Why is REQ-95 needed?" and their bell stayed
// empty, since `question.asked` had no notification consumer.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  truncateAll,
} from '../helpers/factories.js';

let projectId: string;
let adminId: string;
let admin: string;
let memberId: string;
let member: string;

const on = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)) as unknown as T[];

beforeAll(async () => {
  const { registerQuestionNotifications } = await import(
    '../../src/notifications/notify-questions.js'
  );
  registerQuestionNotifications();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  adminId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(adminId)).id;
  admin = await userToken(adminId);
  memberId = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, memberId, 'member');
  member = await userToken(memberId);
});

/** Hands every `type` event not yet handed over to the `notify-questions` consumer, once each. */
const handed = new Set<string>();
async function drain(type: 'question.asked' | 'question.answered'): Promise<void> {
  const { consumerOf } = await import('../../src/outbox/consumers.js');
  const consumer = consumerOf(type, 'notify-questions');
  expect(consumer, `notify-questions consumes ${type}`).toBeDefined();
  const events = await rows<{ id: string; payload: Record<string, unknown> }>(sql`
    SELECT id, payload FROM pipeline_outbox WHERE type = ${type} ORDER BY created_at`);
  for (const e of events) {
    if (handed.has(e.id)) continue;
    handed.add(e.id);
    await consumer?.handle(e.payload as never, { eventId: e.id } as never);
  }
}

/** The bell as its reader sees it: the open rows of this project, and the badge over them. */
async function bell(token: string): Promise<{ count: number; items: Body[] }> {
  const count = await api(token, 'GET', `/api/notifications/open-count?projectId=${projectId}`);
  expect(count.status, JSON.stringify(count.body)).toBe(200);
  const list = await api(
    token,
    'GET',
    `/api/notifications?projectId=${projectId}&openOnly=true&page=1&pageSize=50`,
  );
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return { count: count.body.count as number, items: list.body.items as Body[] };
}

async function questionsOf(key: string): Promise<Body[]> {
  const r = await on(member, 'GET', `/requirements/${key}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.questions as Body[];
}

describe('a question asked of a requirement reaches its author (REQ-34 BC-21)', () => {
  it('rings the author once per requirement, never the asker, and answering it resolves the row', async () => {
    // the member writes REQ-1 from its title alone: core asks its author why it is needed
    const made = await on(member, 'POST', '/requirements', {
      title: 'Cards export to CSV',
      criteria: [{ body: 'A nurse exports the cards' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = String(made.body.key);
    await drain('question.asked');

    const first = await bell(member);
    expect(first.count).toBe(1);
    expect(first.items).toHaveLength(1);
    expect(String(first.items[0]?.title)).toContain(key);
    expect((await bell(admin)).count).toBe(0);

    // the member reads the row, then the admin asks the author a second question on the same item
    const read = await api(member, 'PATCH', `/api/notifications/${String(first.items[0]?.id)}`, {
      read: true,
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    await makeAgreeReady(projectId, Number(key.slice(4)), memberId);
    for (const path of [
      `/requirements/${key}/revisions/1/propose`,
      `/requirements/${key}/revisions/1/accept`,
    ]) {
      const body = path.endsWith('/accept') ? { reason: 'Accepted for this test.' } : {};
      const r = await on(member, 'POST', path, body);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
    }
    const asked = await on(admin, 'POST', `/requirements/${key}/revisions`, {
      baseRevision: 1,
      reason: 'Which export format the clinic reads.',
      spec: {
        openQuestions: [
          { question: 'Do the cards export as CSV or XLSX?', whoAnswers: 'its author', blocking: false },
        ],
      },
      criteria: [{ code: 'BC-1', body: 'A nurse exports the cards' }],
    });
    expect(asked.status, JSON.stringify(asked.body)).toBeLessThan(300);
    await drain('question.asked');

    // one row for the item, new again; the asker's bell stays empty
    const second = await bell(member);
    expect(second.count).toBe(1);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).toBe(first.items[0]?.id);
    expect(second.items[0]?.readAt ?? null).toBeNull();
    expect((await bell(admin)).count).toBe(0);

    // answering both questions resolves the row
    for (const q of (await questionsOf(key)).filter((x) => x.status === 'open')) {
      const r = await api(member, 'POST', `/api/questions/${String(q.id)}/answer`, {
        text: 'CSV, as the clinic reads it.',
        round: 1,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    await drain('question.answered');
    expect((await bell(member)).count).toBe(0);
  });

  it('never rings the asker when the asker is the author', async () => {
    const made = await on(member, 'POST', '/requirements', {
      title: 'Cards print on A5',
      reason: 'Clinics print on A5 paper.',
      spec: {
        openQuestions: [{ question: 'Which printers?', whoAnswers: 'its author', blocking: false }],
      },
      criteria: [{ body: 'A nurse prints a card on A5' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await drain('question.asked');
    expect((await bell(member)).count).toBe(0);
    expect((await bell(admin)).count).toBe(0);
  });
});
