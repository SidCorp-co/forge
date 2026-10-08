import { randomUUID } from 'node:crypto';
import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendMessages, recordDeliveredReply } from '../../src/conversations/index.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// Share on any message of an assistant turn shares the whole turn as one frozen document: the
// question it answered as its title, the reply the room was shown, and every block the turn posted
// above it, in order, each run read again as the creator (REQ-32, lane A8d). On dev.185 a share
// froze the one block whose message was pressed and was titled by its template id.

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);

let w: World;
let member: { id: string; token: string };
let roomId: string;

const runQuery = async (token = w.token) => {
  const res = await api(
    token,
    'POST',
    `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ReportRunSchema.parse(res.body);
};
const show = (block: Body, token = w.token) =>
  api(token, 'POST', `/api/conversations/${roomId}/blocks`, { projectId: w.projectId, block });
const messages = async () =>
  ((await api(w.token, 'GET', `/api/conversations/${roomId}`)).body.messages as Body[]) ?? [];

beforeAll(async () => {
  w = await world();
  const user = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, user.id, 'member');
  member = { id: user.id, token: await userToken(user.id) };
  const opened = await api(w.token, 'POST', '/api/conversations', {
    projectId: w.projectId,
    title: 'where it stands',
    people: [member.id],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  roomId = String(opened.body.id);
}, 120_000);

describe('sharing a chat answer', () => {
  const QUESTION =
    'Báo cáo tình trạng dự án Forge cho tôi: tiến độ theo requirement, tình trạng release, và lộ trình sắp tới. Kèm tóm tắt, rủi ro và đề xuất.'; // i18n-allow: the dev.185 question under test
  const REPLY = '## Summary\n\n**REQ-11** is closest: its criteria are nearly all proven.';

  /** A person asks, then the turn's blocks land above its reply, each its own message. */
  const ask = (asker: string, question = 'How far along are we?') =>
    appendMessages({
      conversationId: roomId,
      messages: [{ role: 'user', authorUserId: asker, content: question }],
    }).then(([m]) => String(m?.id));
  const answerWithTable = async (token: string) => {
    const run = await runQuery(token);
    const res = await show(
      { kind: 'table', columns: ['key'], source: { runId: run.runId } },
      token,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { run, messageId: String(res.body.messageId) };
  };
  const reply = async (text: string, deliveryKey = `window:${randomUUID()}`) => {
    await recordDeliveredReply({
      conversationId: roomId,
      projectId: w.projectId,
      text,
      receipt: { messageId: randomUUID() },
      deliveryKey,
      askedBy: w.userId,
    });
    const said = (await messages()).filter((m) => m.content === text).at(-1);
    return String(said?.id);
  };
  const share = (token: string, messageId: string) =>
    api(token, 'POST', `/api/projects/${w.projectId}/shares`, {
      subjectKind: 'message',
      subjectId: messageId,
      audience: 'members',
    });
  const openedBy = async (token: string, created: { body: Body }) => {
    const url = String(created.body.url);
    const opened = await api(token, 'POST', '/api/shares/open/member', {
      token: url.slice(url.indexOf('/s/') + 3),
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return opened.body.document as Body;
  };

  it('freezes the whole turn from any of its messages: the question as its title, the reply and all three blocks in order', async () => {
    await ask(w.userId, QUESTION);
    const first = await answerWithTable(w.token);
    const second = await answerWithTable(w.token);
    const third = await answerWithTable(w.token);
    const replyId = await reply(REPLY);
    // the next person's message ends the turn: what is said after it is another answer's
    await ask(member.id, 'And the next one?');
    await answerWithTable(w.token);
    await reply('REQ-12 is next.');

    for (const subject of [replyId, first.messageId, third.messageId]) {
      const created = await share(w.token, subject);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((created.body.share as Body).title).toBe(
        'Báo cáo tình trạng dự án Forge cho tôi: tiến độ theo requirement, tình trạng release, và lộ trình sắp tới. Kèm tóm tắt…', // i18n-allow: the dev.185 question under test
      );
      const document = await openedBy(member.token, created);
      expect(document).toMatchObject({ templateId: 'chat-answer', version: 2, reply: REPLY });
      expect(String(document.title)).not.toContain('chat-answer');
      expect(document.runs).toEqual([first.run, second.run, third.run]);
      expect((document.blocks as Body[]).map((b) => (b.source as Body).runId)).toEqual([
        first.run.runId,
        second.run.runId,
        third.run.runId,
      ]);
    }
  });

  it('freezes the rest of a turn that ran past its first ceiling, not the partial that said it was still working', async () => {
    await ask(w.userId);
    const key = `window:${randomUUID()}`;
    const partialId = await reply(
      'forge has not finished this after 90 seconds — still working…',
      key,
    );
    await answerWithTable(w.token);
    await reply(REPLY, `${key}:continued`);
    const document = await openedBy(member.token, await share(w.token, partialId));
    expect(document.reply).toBe(REPLY);
    expect(document.title).toBe('How far along are we?');
  });

  it("re-reads the answer's runs as the creator: a member who did not ask is refused by name", async () => {
    await ask(w.userId);
    const { messageId } = await answerWithTable(w.token);
    const res = await share(member.token, messageId);
    expect([res.status, code(res)]).toEqual([403, 'REPORT_RUN_READ_FORBIDDEN']);
  });

  it("re-checks the asker's permission on the run when the share is made", async () => {
    await ask(member.id);
    const { run, messageId } = await answerWithTable(member.token);
    await db.execute(
      sql`UPDATE report_runs SET permission = 'project.admin' WHERE id = ${run.runId}`,
    );
    const res = await share(member.token, messageId);
    expect([res.status, code(res)]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(detail(res)).toContain(`read report run ${run.runId}`);
  });

  it("refuses a person's message, and an id no message has, by name", async () => {
    const asked = await ask(w.userId);
    const person = await share(w.token, asked);
    expect([person.status, code(person)]).toEqual([404, 'SHARE_SUBJECT_NOT_FOUND']);
    expect(detail(person)).toContain("is a person's message");
    const none = await share(w.token, '00000000-0000-4000-8000-000000000000');
    expect([none.status, code(none)]).toEqual([404, 'SHARE_SUBJECT_NOT_FOUND']);
  });
});
