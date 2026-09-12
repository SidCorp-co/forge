/**
 * ISS-978 — a reply in a question's thread, answered or refused by name.
 *
 * Every refusal is judged twice: by what the thread was told, and by reading
 * the question row back. A refusal that posted the right sentence and still
 * wrote an answer is the failure worth catching, and only the second read sees
 * it.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const said: string[] = [];

vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(async (_transport: unknown, text: string, proof: unknown) => {
      if (proof !== actual.FIXED_REPLY_CONSTANT && !(proof as { ok?: boolean })?.ok) {
        throw new Error('unscreened text reached the outbound door');
      }
      said.push(text);
      return { messageId: `ack-${said.length}` };
    }),
  };
});

const SERVER_URL = 'https://chat.example.com';

let harness: TestDatabase;
let inbound: typeof import('../../src/integrations/rocketchat/question-inbound.js');
let write: typeof import('../../src/questions/write.js');
let qSchema: typeof import('../../src/db/schema-questions.js');
let db: typeof import('../../src/db/client.js').db;

let projectId: string;
let ownerId: string;
let memberId: string;
let issueId: string;
let seq = 0;

const SAFE = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};
const RISKY = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Drop the column',
  authority: 'admin' as const,
  bindsTo: 'project' as const,
  executedBy: 'human' as const,
};

const transport = {
  kind: 'rest' as const,
  auth: { serverUrl: SERVER_URL, authToken: 't', userId: 'bot' },
  rid: 'room-1',
  tmid: 'thread-1',
};

const message = (over: Partial<{ text: string; userId: string; username: string }> = {}) => ({
  id: `m-${randomUUID()}`,
  rid: 'room-1',
  tmid: 'thread-1',
  text: over.text ?? '1',
  userId: over.userId ?? 'rc-member',
  username: over.username ?? 'member.one',
  isSystem: false,
  isEdited: false,
  mentions: [] as string[],
  images: [],
});

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  inbound = await import('../../src/integrations/rocketchat/question-inbound.js');
  write = await import('../../src/questions/write.js');
  qSchema = await import('../../src/db/schema-questions.js');
  ({ db } = await import('../../src/db/client.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  said.length = 0;
  const owner = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = owner.id;
  const member = await createTestUser(harness.db, { email: `member-${randomUUID()}@example.com` });
  memberId = member.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: memberId, projectId, role: 'member' });
  issueId = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${800 + seq}, 'A parked issue', 'in_progress', ${ownerId})
  `);
});

async function linkSpeaker(externalId: string, userId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', 'chat.example.com', ${externalId}, 'label', ${userId}, 'admin')
  `);
}

async function ask() {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    issueId,
    prompt: 'The migration drops a column. Which way?',
    blockerKind: 'human',
    options: [SAFE, RISKY],
    recommendedOptionId: SAFE.id,
  });
}

const reload = async (id: string) =>
  (await db.select().from(qSchema.agentQuestions).where(eq(qSchema.agentQuestions.id, id)))[0];

const answerOn = (row: { steps: Array<{ chosenOptionId?: string }> } | undefined) =>
  row?.steps.map((s) => s.chosenOptionId ?? null) ?? [];

describe('a reply that names an option', () => {
  it('records it against the Forge user the speaker maps to', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '1' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('answered');
    expect(row?.steps[0]?.chosenOptionId).toBe(SAFE.id);
    expect(row?.steps[0]?.answeredBy).toBe(memberId);
    expect(said.join(' ')).toContain('Recorded');
    expect(said.join(' ')).toContain('@member.one');
  });

  it('writes no issue comment, so the prose resume lane does not also fire', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '1' }),
      transport,
    });
    const comments = await harness.db.execute(
      sql`SELECT id FROM comments WHERE issue_id = ${issueId}`,
    );
    expect(comments).toHaveLength(0);
  });

  it('crosses the same authority gate the HTTP surface does', async () => {
    // cm:guard an ADMIN-authority option chosen by a project member must be refused here exactly as `POST /questions/:id/answer` refuses it — the handler calling `answerQuestion` directly would pass this option and fail nothing else (ISS-978 criterion 11).
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '2' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('open');
    expect(answerOn(row)).toEqual([null]);
    expect(said.join(' ')).toContain('authority admin');
  });

  it('lets an admin choose the admin-authority option', async () => {
    await linkSpeaker('rc-owner', ownerId);
    await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '2', userId: 'rc-owner', username: 'owner.one' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('answered');
    expect(row?.steps[0]?.chosenOptionId).toBe(RISKY.id);
  });
});

describe('the four refusals, each by name and none of them guessing', () => {
  it('refuses an unmapped speaker with the identity module own text', async () => {
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '1', userId: 'rc-stranger' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('open');
    expect(answerOn(row)).toEqual([null]);
    const { unlinkedMessage } = await import('../../src/assistant/identity/speaker-link.js');
    const expected = unlinkedMessage({
      source: 'rocketchat',
      namespace: 'chat.example.com',
      externalId: 'rc-stranger',
      label: 'member.one',
    });
    expect(said).toEqual([expected]);
  });

  it('refuses a stale round rather than applying it to the latest step', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'Neither worked. Which now?',
      options: [SAFE, RISKY],
      recommendedOptionId: SAFE.id,
    });
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '1-1' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('open');
    expect(answerOn(row)).toEqual([null, null]);
    expect(said.join(' ')).toContain('round 1');
    expect(said.join(' ')).toContain('superseded');
  });

  it('refuses a bare number once a second round exists, naming the grammar', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await write.askFollowUp({
      questionId: q.id,
      prompt: 'Neither worked. Which now?',
      options: [SAFE, RISKY],
      recommendedOptionId: SAFE.id,
    });
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '1' }),
      transport,
    });
    expect(answerOn(await reload(q.id))).toEqual([null, null]);
    expect(said.join(' ')).toContain('2-1');
  });

  it('re-posts the options when a reply matches none, rather than inferring or recommending', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: 'whatever you think is best' }),
      transport,
    });
    const row = await reload(q.id);
    expect(row?.status).toBe('open');
    expect(answerOn(row)).toEqual([null]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('1. Take the safe path');
    expect(said[0]).toContain('2. Drop the column');
    // cm:guard the re-post must not carry the recommendation: a person who typed prose gets the list back, not a nudge toward one answer (ISS-978 criterion 18).
    expect(said[0]).not.toContain('recommended');
  });

  it('refuses an option number that is on no round', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: SERVER_URL,
      m: message({ text: '7' }),
      transport,
    });
    expect(answerOn(await reload(q.id))).toEqual([null]);
    expect(said.join(' ')).toContain('no option `7`');
  });

  it('refuses a second answer to a question already answered', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    const send = () =>
      inbound.handleQuestionThreadReply({
        questionId: q.id,
        serverUrl: SERVER_URL,
        m: message({ text: '1' }),
        transport,
      });
    await send();
    said.length = 0;
    await send();
    const row = await reload(q.id);
    expect(row?.steps[0]?.answeredBy).toBe(memberId);
    expect(said.join(' ')).toContain('only an open question takes an answer');
  });
});

describe('every path consumes the message', () => {
  it('posts into the thread on each refusal as well as on the answer', async () => {
    const cases: Array<{ link: boolean; text: string }> = [
      { link: false, text: '1' },
      { link: true, text: '2' },
      { link: true, text: 'prose' },
      { link: true, text: '9' },
      { link: true, text: '1' },
    ];
    for (const c of cases) {
      await truncateAll(harness.db);
      said.length = 0;
      const owner = await createTestUser(harness.db, {
        email: `o-${randomUUID()}@example.com`,
      });
      const project = await createTestProject(harness.db, owner.id);
      projectId = project.id;
      const member = await createTestUser(harness.db, {
        email: `m-${randomUUID()}@example.com`,
      });
      memberId = member.id;
      await createTestProjectMember(harness.db, { userId: memberId, projectId, role: 'member' });
      issueId = randomUUID();
      seq += 1;
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (${issueId}, ${projectId}, ${700 + seq}, 'A parked issue', 'in_progress', ${owner.id})
      `);
      if (c.link) await linkSpeaker('rc-member', memberId);
      const q = await ask();
      await inbound.handleQuestionThreadReply({
        questionId: q.id,
        serverUrl: SERVER_URL,
        m: message({ text: c.text }),
        transport,
      });
      // cm:guard something was said on EVERY path — a path that returns silently is one the connection manager would have to fall through from, and the person who was asked to pick an option gets a chat reply about something else (ISS-978 criterion 20).
      expect(said.length, `nothing was said for reply "${c.text}"`).toBeGreaterThan(0);
    }
  });

  it('reports rather than answers when the connection has no live socket', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    inbound.consumeQuestionThreadReply({
      questionId: q.id,
      connectionId: 'conn-1',
      ac: { serverUrl: SERVER_URL, authToken: 't', client: undefined },
      m: message({ text: '1' }),
    });
    await new Promise((r) => setImmediate(r));
    // cm:guard no socket means no answer AND no throw: the message is still consumed, so the caller must not fall through to the conversation handler on it (ISS-978 criterion 20).
    expect(said).toEqual([]);
    expect(answerOn(await reload(q.id))).toEqual([null]);
  });

  it('says so rather than throwing when the server address is unreadable', async () => {
    await linkSpeaker('rc-member', memberId);
    const q = await ask();
    await inbound.handleQuestionThreadReply({
      questionId: q.id,
      serverUrl: 'not-a-url',
      m: message({ text: '1' }),
      transport,
    });
    expect(answerOn(await reload(q.id))).toEqual([null]);
    expect(said.join(' ')).toContain('cannot be read as a channel identity');
  });
});
