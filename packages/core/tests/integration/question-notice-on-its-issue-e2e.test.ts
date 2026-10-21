/**
 * ISS-1228 round 23 (judge-74, criteria 236-238) — on a project with no Rocket.Chat room, each question
 * an agent asked on an issue raised a warning that it "cannot be delivered … Nothing was posted
 * anywhere", though it was on the issue's page and answered there, and the warning stood after the
 * answer: only a Rocket.Chat post ended it. A question on its issue is delivered there; a room is
 * optional; and every notice about a question ends once the question does.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

let postThrows: Error | null = null;
vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(async () => {
      if (postThrows) throw postThrows;
      return { messageId: 'msg-1' };
    }),
  };
});

let harness: TestDatabase;
let delivery: typeof import('../../src/integrations/rocketchat/question-delivery.js');
let write: typeof import('../../src/questions/write.js');
let store: typeof import('../../src/integrations/store.js');
let bus: import('../../src/pipeline/hooks.js').HooksBus;

let projectId: string;
let ownerId: string;
let issueId: string;

const SAFE = {
  id: '22222222-2222-4222-8222-222222222222',
  label: 'Take the safe path',
  authority: 'writer' as const,
  bindsTo: 'session' as const,
  executedBy: 'agent' as const,
};
const OTHER = { ...SAFE, id: '11111111-1111-4111-8111-111111111111', label: 'Take the other path' };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  delivery = await import('../../src/integrations/rocketchat/question-delivery.js');
  write = await import('../../src/questions/write.js');
  store = await import('../../src/integrations/store.js');
  const { HooksBus } = await import('../../src/pipeline/hooks.js');
  bus = new HooksBus();
  delivery.registerQuestionNoticeClear(bus);
});

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  postThrows = null;
  ownerId = (await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 6, 'A parked issue', 'in_progress', ${ownerId})
  `);
});

async function bindRoom(rid = 'room-1'): Promise<void> {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'rocketchat',
    config: { serverUrl: 'https://chat.example.com' },
    secrets: { authToken: 'tok', userId: 'bot' },
  });
  await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'rocketchat',
    role: 'service',
    config: { rids: [rid] },
  });
}

async function ask(on: string | null = issueId) {
  return write.askQuestion({
    id: randomUUID(),
    projectId,
    ...(on ? { issueId: on } : {}),
    prompt: 'Which database should the import read from?',
    blockerKind: 'human',
    answer: { shape: 'choice', options: [SAFE, OTHER], recommendedOptionId: SAFE.id },
  });
}

async function deliverAll(at = new Date()) {
  for (const round of await delivery.owedRounds(at)) await delivery.deliverOwedRound(round, at);
}

type Notice = { title: string; body: string | null; severity: string | null; resolved: boolean };
async function noticesFor(questionId: string): Promise<Notice[]> {
  return harness.db.execute<Notice>(sql`
    SELECT title, body, severity, resolved_at IS NOT NULL AS resolved
      FROM notifications WHERE resolution_key = ${`rocketchat-question-undeliverable:${questionId}`}
  `);
}

async function answer(questionId: string) {
  const [row] = await harness.db.execute<{ steps: Array<{ round: number }> }>(
    sql`SELECT steps FROM agent_questions WHERE id = ${questionId}`,
  );
  const round = row?.steps.at(-1)?.round ?? 1;
  await write.answerQuestion({
    questionId,
    answer: { kind: 'option', optionId: SAFE.id },
    round,
    by: ownerId,
    role: 'admin',
  });
}

describe('a question asked on an issue of a project with no room (criterion 236)', () => {
  it('raises no notice: its issue page is where it is delivered', async () => {
    const q = await ask();
    await deliverAll();
    expect(await noticesFor(q.id)).toEqual([]);
  });

  it('still warns about a question on no issue, which has nowhere else to be', async () => {
    const q = await ask(null);
    await deliverAll();
    const [notice] = await noticesFor(q.id);
    expect(notice).toMatchObject({ severity: 'warning', resolved: false });
    expect(notice?.body).toContain('Nothing was posted anywhere');
  });

  it('ends a warning raised before this change about a question still on its issue', async () => {
    const q = await ask();
    const { emitNotification } = await import('../../src/notifications/emit.js');
    await emitNotification({
      userId: ownerId,
      projectId,
      issueId,
      type: 'ops_alert',
      severity: 'warning',
      title: 'scratch has a question waiting that cannot be delivered',
      body: 'Nothing was posted anywhere.',
      resolutionKey: `rocketchat-question-undeliverable:${q.id}`,
    });
    expect(await noticesFor(q.id)).toMatchObject([{ resolved: false }]);
    await deliverAll();
    expect(await noticesFor(q.id)).toMatchObject([{ resolved: true }]);
  });
});

describe('a bound room that cannot take a question asked on an issue (criterion 237)', () => {
  it('says the question is on its issue page and the room is optional, as information', async () => {
    await bindRoom();
    postThrows = new Error('chat.postMessage failed: error-not-allowed');
    const q = await ask();
    await deliverAll();
    const [notice] = await noticesFor(q.id);
    expect(notice?.severity).toBe('info');
    expect(notice?.title).toMatch(
      /^A question on [A-Z]+-6 could not also be posted to Rocket\.Chat$/,
    );
    expect(notice?.body).toMatch(/^The question is on [A-Z]+-6's page, where it can be answered\./);
    expect(notice?.body).toContain('A chat room is optional');
    expect(notice?.body).not.toContain('Nothing was posted anywhere');
  });
});

describe('a notice about a question ends with the question (criterion 238)', () => {
  it('ends when the question is answered, at the answer', async () => {
    const q = await ask(null);
    await deliverAll();
    expect(await noticesFor(q.id)).toMatchObject([{ resolved: false }]);
    await answer(q.id);
    await bus.emit('questionAnswered', {
      questionId: q.id,
      projectId,
      issueId: null,
      answeredBy: ownerId,
      body: 'x',
    });
    expect(await noticesFor(q.id)).toMatchObject([{ resolved: true }]);
  });

  it('ends on the next drain when the question is voided', async () => {
    const q = await ask(null);
    await deliverAll();
    await write.voidQuestion({ questionId: q.id, reason: 'the run that asked it was cancelled' });
    await delivery.drainQuestionDeliveries();
    expect(await noticesFor(q.id)).toMatchObject([{ resolved: true }]);
  });

  it("ends on the next drain for an answer no hook carried, and leaves an open question's notice", async () => {
    const answered = await ask(null);
    const open = await ask(null);
    await deliverAll();
    await answer(answered.id);
    await delivery.drainQuestionDeliveries();
    expect(await noticesFor(answered.id)).toMatchObject([{ resolved: true }]);
    expect(await noticesFor(open.id)).toMatchObject([{ resolved: false }]);
  });
});
