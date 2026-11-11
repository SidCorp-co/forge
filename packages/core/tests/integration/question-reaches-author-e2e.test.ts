// REQ-34 BC-21, ISS-456 criterion 4: a step that asks the author something reaches them as a
// notification. A question asked of a requirement rings its author's bell when it is asked, as one row
// per requirement, and never the bell of whoever asked it; answering it resolves the row. Judge run
// ad038e31 on dev.649: REQ-95's create asked its author "Why is REQ-95 needed?" and their bell stayed
// empty, since `question.asked` had no notification consumer.
//
// ISS-1213: an item that leaves for good (a requirement dropped, a feedback item declined) voids its
// open questions in the move's own transaction with the move's reason, so the asked person's row
// resolves. Judge run b328d2a4 on dev.651: REQ-96 was dropped and its author's bell still held "Why is
// REQ-96 needed?" 40 minutes later, since the drop voided only the Steward's decisions.
//
// @direct-test-of packages/core/src/questions/moved-decisions.ts
// @direct-test-of packages/core/src/requirements/write-tx.ts
// @direct-test-of packages/core/src/feedback/leave-questions.ts

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
import { underStrict } from '../helpers/project-controls.js';

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
async function drain(
  type: 'question.asked' | 'question.answered' | 'question.transitioned',
): Promise<void> {
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
    // a business question a revision leaves open is a person's on a strict project (REQ-79 BC-13)
    const asked = await underStrict(projectId, adminId, () =>
      on(admin, 'POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'Which export format the clinic reads.',
        spec: {
          openQuestions: [
            {
              question: 'Do the cards export as CSV or XLSX?',
              whoAnswers: 'its author',
              blocking: false,
            },
          ],
        },
        criteria: [{ code: 'BC-1', body: 'A nurse exports the cards' }],
      }),
    );
    expect(asked.status, JSON.stringify(asked.body)).toBeLessThan(300);
    await drain('question.asked');
    const second = (await questionsOf(key)).find(
      (q) => q.prompt === 'Do the cards export as CSV or XLSX?',
    );
    expect(second?.status).toBe('open');
    const [kind] = await rows<{ blocker_kind: string; asked_by: string | null }>(
      sql`SELECT blocker_kind, asked_by FROM agent_questions WHERE id = ${String(second?.id)}`,
    );
    expect(kind).toEqual({ blocker_kind: 'human', asked_by: adminId });

    // one row for the item, new again; the asker's bell stays empty
    const again = await bell(member);
    expect(again.count).toBe(1);
    expect(again.items).toHaveLength(1);
    expect(again.items[0]?.id).toBe(first.items[0]?.id);
    expect(again.items[0]?.readAt ?? null).toBeNull();
    expect((await bell(admin)).count).toBe(0);

    // the three-day reminder joins the item's row rather than ringing a second one
    const { sweepDecisionUpkeep } = await import('../../src/steward/decision-upkeep.js');
    const reminded = await sweepDecisionUpkeep(new Date(Date.now() + 4 * 86_400_000));
    expect(reminded.reminded).toBeGreaterThanOrEqual(1);
    const rowsOfMember = await rows<{ id: string }>(sql`
      SELECT d.id FROM notification_deliveries d
       WHERE d.user_id = ${memberId} AND d.resolved_notice = false`);
    expect(rowsOfMember.map((r) => r.id)).toEqual([first.items[0]?.id]);

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
    const made = await underStrict(projectId, adminId, () =>
      on(member, 'POST', '/requirements', {
        title: 'Cards print on A5',
        reason: 'Clinics print on A5 paper.',
        spec: {
          openQuestions: [
            { question: 'Which printers?', whoAnswers: 'its author', blocking: false },
          ],
        },
        criteria: [{ body: 'A nurse prints a card on A5' }],
      }),
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await drain('question.asked');
    expect((await bell(member)).count).toBe(0);
    expect((await bell(admin)).count).toBe(0);
  });
});

/** The question rows of this project's bell that are not yet resolved. */
async function openAsks(): Promise<{ title: string }[]> {
  return rows(sql`
    SELECT title FROM notifications
     WHERE project_id = ${projectId} AND type = 'question_asked' AND resolved_at IS NULL`);
}

/** The open and void questions, with their void reasons, in this project, by item column. */
async function questionRows(): Promise<{ status: string; void_reason: string | null }[]> {
  return rows(sql`
    SELECT status, void_reason FROM agent_questions WHERE project_id = ${projectId} ORDER BY created_at`);
}

describe('an item that leaves for good takes its open questions with it (ISS-1213)', () => {
  it('a dropped requirement voids its author question with the drop reason, and the author bell resolves', async () => {
    const made = await on(member, 'POST', '/requirements', {
      title: 'Cards export to PDF',
      criteria: [{ body: 'A nurse exports the cards as PDF' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = String(made.body.key);
    await drain('question.asked');
    expect((await bell(member)).count).toBe(1);
    expect((await questionsOf(key)).filter((q) => q.status === 'open')).toHaveLength(1);

    const dropped = await on(admin, 'POST', `/requirements/${key}/drop`, {
      reason: 'The clinic prints the cards, so no export is needed.',
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);

    const after = await questionRows();
    expect(after.map((q) => q.status)).toEqual(['void']);
    expect(after[0]?.void_reason).toContain('The clinic prints the cards, so no export is needed.');
    await drain('question.transitioned');
    expect(await openAsks()).toEqual([]);
    expect((await bell(member)).count).toBe(0);
  });

  it('a declined feedback item voids its open clarification with the decline reason, and the reporter bell resolves', async () => {
    const filed = await api(member, 'POST', `/api/projects/${projectId}/feedback`, {
      kind: 'bug',
      severity: 'low',
      title: 'The board drops a column on resize',
      screen: 'the board',
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const [fb] = await rows<{ fb_seq: number }>(
      sql`SELECT fb_seq FROM feedback WHERE project_id = ${projectId}`,
    );
    const key = `FB-${fb?.fb_seq}`;
    const asked = await on(admin, 'POST', `/feedback/${key}/clarification`, {
      prompt: 'Which browser shows it?',
      needed: 'The browser and its version',
      recommended: 'Chrome 130 on macOS',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    await drain('question.asked');
    expect((await bell(member)).count).toBe(1);
    expect((await questionRows()).map((q) => q.status)).toEqual(['open']);

    const declined = await on(admin, 'POST', `/feedback/${key}/triage`, {
      route: 'decline',
      note: 'The board resizes by design; the column folds into the menu.',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);

    const after = await questionRows();
    expect(after.map((q) => q.status)).toEqual(['void']);
    expect(after[0]?.void_reason).toContain(
      'The board resizes by design; the column folds into the menu.',
    );
    await drain('question.transitioned');
    // the decline rings its own notice to the reporter; the question's own row is resolved
    expect(await openAsks()).toEqual([]);
  });

  it('an agreed requirement keeps its author question open', async () => {
    const made = await on(member, 'POST', '/requirements', {
      title: 'Cards export to XLSX',
      criteria: [{ body: 'A nurse exports the cards as XLSX' }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const key = String(made.body.key);
    await drain('question.asked');
    await makeAgreeReady(projectId, Number(key.slice(4)), memberId);
    for (const [path, body] of [
      [`/requirements/${key}/revisions/1/propose`, {}],
      [`/requirements/${key}/revisions/1/accept`, { reason: 'Accepted for this test.' }],
    ] as const) {
      const r = await on(member, 'POST', path, body);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
    }
    const agreed = await on(member, 'POST', `/requirements/${key}/agree`, {
      revision: 1,
      reason: 'Agreed with the owner for this test.',
    });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(200);
    expect(agreed.body.status).toBe('agreed');
    expect((await questionRows()).map((q) => q.status)).toEqual(['open']);
    await drain('question.transitioned');
    expect(await openAsks()).toHaveLength(1);
    expect((await bell(member)).count).toBe(1);
  });
});
