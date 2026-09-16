/**
 * ISS-981 — who may author a reply typed in an issue's thread, and where it goes.
 *
 * The sibling file covers the writes themselves, which are exactly-once, and the
 * registry the two halves share. These are the decisions made BEFORE a write:
 * whether the speaker is anybody Forge knows, whether the thread is still live,
 * and — once a comment does exist — whether it reaches the session that parked
 * waiting for it rather than starting a second one beside it.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as conversationSchema from '../../src/db/schema-conversations.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const posts: Array<{ rid: string; tmid: string | undefined; text: string }> = [];
let nextMessageId: string | null = null;
let postCount = 0;
let postThrows: Error | null = null;
let atPostTime: (() => Promise<void>) | null = null;

vi.mock('../../src/integrations/rocketchat/outbound.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/integrations/rocketchat/outbound.js')>();
  return {
    ...actual,
    sendFixedReply: vi.fn(
      async (transport: { rid: string; tmid?: string }, text: string, proof: unknown) => {
        if (proof !== actual.FIXED_REPLY_CONSTANT && !(proof as { ok?: boolean })?.ok) {
          throw new Error('unscreened text reached the outbound door');
        }
        if (atPostTime) await atPostTime();
        if (postThrows) throw postThrows;
        postCount += 1;
        posts.push({ rid: transport.rid, tmid: transport.tmid, text });
        return { messageId: nextMessageId ?? `posted-${postCount}` };
      },
    ),
  };
});

let harness: TestDatabase;
let inbound: typeof import('../../src/integrations/rocketchat/comment-inbound.js');
let store: typeof import('../../src/integrations/store.js');
let db: typeof import('../../src/db/client.js').db;
let schema: typeof import('../../src/db/schema.js');
let rcSchema: typeof import('../../src/db/schema-rocketchat.js');
let rcLinks: typeof import('../../src/db/schema-speaker-links.js');
let rcQuestions: typeof import('../../src/db/schema-questions.js');
type RcMessage =
  import('../../src/integrations/rocketchat/ddp-client.js').RocketChatIncomingMessage;

let projectId: string;
let ownerId: string;
let issueId: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  inbound = await import('../../src/integrations/rocketchat/comment-inbound.js');
  store = await import('../../src/integrations/store.js');
  schema = await import('../../src/db/schema.js');
  rcSchema = await import('../../src/db/schema-rocketchat.js');
  rcLinks = await import('../../src/db/schema-speaker-links.js');
  rcQuestions = await import('../../src/db/schema-questions.js');
  ({ db } = await import('../../src/db/client.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

/** The watermark the migration seeds is re-seeded here, since truncateAll clears it. */
async function seedWatermark(since: Date = new Date(Date.now() - 60_000)): Promise<void> {
  await db
    .insert(rcSchema.rocketchatCommentMirrorState)
    .values({ only: true, since })
    .onConflictDoUpdate({ target: rcSchema.rocketchatCommentMirrorState.only, set: { since } });
}

beforeEach(async () => {
  await truncateAll(harness.db);
  posts.length = 0;
  postCount = 0;
  nextMessageId = null;
  postThrows = null;
  atPostTime = null;
  const user = await createTestUser(harness.db, { email: `owner-${randomUUID()}@example.com` });
  ownerId = user.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  issueId = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, ${700 + seq}, 'Rooms and issues', 'in_progress', ${ownerId})
  `);
  await seedWatermark();
});

async function bindRoom(rid = 'room-1'): Promise<string> {
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
  return connection.id;
}

const commentRows = async () =>
  db.select().from(schema.comments).where(eq(schema.comments.issueId, issueId));

describe('who may author, and what a refusal costs', () => {
  const LINKED = 'rc-person';
  const STRANGER = 'rc-stranger';

  async function linkSpeaker(externalId: string): Promise<void> {
    await db.insert(rcLinks.assistantSpeakerLinks).values({
      source: 'rocketchat',
      externalNamespace: 'chat.example.com',
      externalId,
      externalLabel: 'Someone',
      userId: ownerId,
      confirmedVia: 'channel_email_match',
    });
  }

  function reply(overrides: Partial<RcMessage> = {}): RcMessage {
    return {
      id: `rc-msg-${randomUUID()}`,
      rid: 'room-1',
      text: 'a sentence typed in the room',
      userId: LINKED,
      username: 'someone',
      isSystem: false,
      isEdited: false,
      images: [],
      tmid: 'root-1',
      ...overrides,
    };
  }

  async function deliver(m: RcMessage, retired = false): Promise<void> {
    await inbound.handleIssueThreadReply({
      issueId,
      retired,
      connectionId: await bindRoom(),
      serverUrl: 'https://chat.example.com',
      m,
      transport: {
        kind: 'rest',
        auth: { serverUrl: 'x', authToken: 't', userId: 'bot' },
        rid: m.rid,
        tmid: m.tmid,
      },
      hooks: new (await import('../../src/pipeline/hooks.js')).HooksBus(),
    });
  }

  it('refuses a speaker no Forge user is linked to, naming the way out in the thread', async () => {
    await deliver(reply({ userId: STRANGER }));

    expect(posts).toHaveLength(1);
    expect(posts[0]?.tmid).toBe('root-1');
    expect(posts[0]?.text).toContain('is not linked to a Forge user');
    expect(posts[0]?.text).toContain('speaker-links');
  });

  it('writes no comment for a speaker nobody is linked to', async () => {
    await deliver(reply({ userId: STRANGER }));

    expect(await commentRows()).toHaveLength(0);
  });

  it('writes the comment as the linked user once the speaker is mapped', async () => {
    await linkSpeaker(LINKED);
    await deliver(reply());

    const rows = await commentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorId).toBe(ownerId);
    expect(rows[0]?.authorDeviceId).toBeNull();
  });

  it('opens no conversation for a reply it carries', async () => {
    await linkSpeaker(LINKED);
    await deliver(reply());

    const rooms = await db.select().from(conversationSchema.conversations);
    expect(rooms).toHaveLength(0);
  });

  it('records no answer against an open question when a person types prose in the issue thread', async () => {
    await linkSpeaker(LINKED);
    const questionId = randomUUID();
    await db.insert(rcQuestions.agentQuestions).values({
      id: questionId,
      projectId,
      issueId,
      blockerKind: 'human',
      steps: [
        {
          round: 1,
          prompt: 'Which way?',
          answerShape: 'choice' as const,
          options: [
            {
              id: 'a',
              label: 'left',
              authority: 'writer' as const,
              bindsTo: 'this_call' as const,
              executedBy: 'agent' as const,
            },
            {
              id: 'b',
              label: 'right',
              authority: 'writer' as const,
              bindsTo: 'this_call' as const,
              executedBy: 'agent' as const,
            },
          ],
          recommendedOptionId: 'a',
          askedAt: new Date().toISOString(),
        },
      ],
    });

    await deliver(reply({ text: 'left, I think' }));

    const [question] = await db
      .select({ status: rcQuestions.agentQuestions.status })
      .from(rcQuestions.agentQuestions)
      .where(eq(rcQuestions.agentQuestions.id, questionId));
    expect(question?.status).toBe('open');
  });

  it('refuses a reply left on a retired thread rather than writing it anywhere', async () => {
    await linkSpeaker(LINKED);
    await deliver(reply(), true);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toBe(inbound.RETIRED_THREAD_REPLY);
    expect(await commentRows()).toHaveLength(0);
  });
});

describe('a reply on a parked issue reaches the session that asked', () => {
  async function parkOnNeedsInfo(): Promise<{ sessionId: string; jobId: string }> {
    await db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { enabled: true } })}::jsonb
      WHERE id = ${projectId}
    `);
    await db.execute(sql`UPDATE issues SET status = 'needs_info' WHERE id = ${issueId}`);
    const runId = randomUUID();
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
    const device = await createTestDevice(harness.db, ownerId);
    const sessionId = randomUUID();
    await db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id, runtime_state)
      VALUES (${sessionId}, ${projectId}, ${device.id}, 'running', ${runId}, 'awaiting_input')
    `);
    const jobId = randomUUID();
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, agent_session_id,
                        pipeline_run_id, payload, queued_at, dispatched_at, created_by)
      VALUES (${jobId}, ${projectId}, ${issueId}, 'drive', 'running', ${sessionId}, ${runId},
              '{}'::jsonb, now(), now(), ${ownerId})
    `);
    return { sessionId, jobId };
  }

  async function replyInRoom(): Promise<string> {
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const { registerAnswerResume } = await import('../../src/pipeline/answer-resume.js');
    const bus = new HooksBus();
    registerAnswerResume(bus);
    await db.insert(rcLinks.assistantSpeakerLinks).values({
      source: 'rocketchat',
      externalNamespace: 'chat.example.com',
      externalId: 'rc-person',
      externalLabel: 'Someone',
      userId: ownerId,
      confirmedVia: 'channel_email_match',
    });
    const connectionId = await bindRoom();
    await inbound.handleIssueThreadReply({
      issueId,
      retired: false,
      connectionId,
      serverUrl: 'https://chat.example.com',
      m: {
        id: `rc-parked-${randomUUID()}`,
        rid: 'room-1',
        text: 'go with the second option',
        userId: 'rc-person',
        username: 'someone',
        isSystem: false,
        isEdited: false,
        images: [],
        tmid: 'root-1',
      },
      transport: {
        kind: 'rest',
        auth: { serverUrl: 'x', authToken: 't', userId: 'bot' },
        rid: 'room-1',
        tmid: 'root-1',
      },
      hooks: bus,
    });
    const [row] = await commentRows();
    return row?.id ?? '';
  }

  it('dispatches no second job beside the session already parked', async () => {
    const { jobId } = await parkOnNeedsInfo();
    await replyInRoom();

    const rows = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(jobId);

    const [issue] = await db
      .select({ status: schema.issues.status })
      .from(schema.issues)
      .where(eq(schema.issues.id, issueId));
    expect(issue?.status).toBe('needs_info');
  });
});
