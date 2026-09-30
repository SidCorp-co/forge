/**
 * ISS-17 — an assistant turn acts as the person whose message it answers, and no wider.
 *
 * Driven end to end through the doors a real turn takes: a message collected into a room, the
 * window routed by the web and Rocket.Chat adapters' own routers, the toolset the turn builds, the
 * `forge` CLI run as a child process against a live core, and the REST route that decides. Only
 * the model is replaced, by one that asks for the same write every time — so what differs between
 * the cases is who the turn runs as, and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type ModelToolset = {
  execute: (
    name: string,
    argsJson: string,
  ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
};

/** What the model's one tool call came back with, per turn. */
const toolRuns: Array<{ isError: boolean; text: string }> = [];
let issueRef = '';

vi.mock('../../src/assistant/external-chat.js', async (orig) => {
  const actual = await orig<typeof import('../../src/assistant/external-chat.js')>();
  return {
    ...actual,
    runExternalChatTurn: vi.fn(async (args: { tools?: ModelToolset }) => {
      const argv = ['comment', issueRef, '-'];
      const res = await args.tools?.execute(
        'forge',
        JSON.stringify({ argv, body: 'Asked for from the room.' }),
      );
      const text = res ? res.content.map((b) => b.text ?? '').join('') : 'no tools';
      toolRuns.push({ isError: res ? Boolean(res.isError) : true, text });
      return {
        conversationId: null,
        assistantMessageId: null,
        reply: res?.isError ? `I could not add that comment: ${text}` : 'I added the comment.',
        terminal: 'done',
        error: null,
        iterations: 1,
        toolCalls: [{ name: 'forge', arguments: JSON.stringify({ argv }), isError: res?.isError }],
        progress: null,
      };
    }),
  };
});

vi.mock('../../src/integrations/rocketchat/context.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/rocketchat/context.js')>()),
  buildConversationContext: vi.fn(async () => null),
}));

let harness: TestDatabase;
let server: TestServer;
let m: {
  store: typeof import('../../src/conversations/store.js');
  participants: typeof import('../../src/conversations/participants.js');
  handles: typeof import('../../src/conversations/handles.js');
  collect: typeof import('../../src/conversations/collect-inbound.js');
  windows: typeof import('../../src/conversations/windows.js');
  ports: typeof import('../../src/conversations/ports.js');
  web: typeof import('../../src/assistant/conversation-adapter.js');
  send: typeof import('../../src/assistant/conversation-send.js');
  rcStore: typeof import('../../src/integrations/store.js');
  rcRoutes: typeof import('../../src/integrations/rocketchat/routes.js');
  rcPort: typeof import('../../src/integrations/rocketchat/conversation-port.js');
  rcDrain: typeof import('../../src/integrations/rocketchat/window-drain.js');
  schema: typeof import('../../src/db/schema.js');
  links: typeof import('../../src/db/schema-speaker-links.js');
};

let ownerId: string;
let projectId: string;
let issueId: string;
let handle: { userId: string; handle: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abcdef';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  process.env.FORGE_CLI_URL = `${server.baseUrl}/mcp`;
  m = {
    store: await import('../../src/conversations/store.js'),
    participants: await import('../../src/conversations/participants.js'),
    handles: await import('../../src/conversations/handles.js'),
    collect: await import('../../src/conversations/collect-inbound.js'),
    windows: await import('../../src/conversations/windows.js'),
    ports: await import('../../src/conversations/ports.js'),
    web: await import('../../src/assistant/conversation-adapter.js'),
    send: await import('../../src/assistant/conversation-send.js'),
    rcStore: await import('../../src/integrations/store.js'),
    rcRoutes: await import('../../src/integrations/rocketchat/routes.js'),
    rcPort: await import('../../src/integrations/rocketchat/conversation-port.js'),
    rcDrain: await import('../../src/integrations/rocketchat/window-drain.js'),
    schema: await import('../../src/db/schema.js'),
    links: await import('../../src/db/schema-speaker-links.js'),
  };
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  toolRuns.length = 0;
  m.ports.registerConversationTransport(m.web.webConversationPorts);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  handle = await harness.db.transaction((tx) =>
    m.handles.resolveProjectHandle(tx as never, projectId),
  );
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 7, 'Something to comment on', 'open', ${ownerId})
  `);
  issueRef = issueId;
});

async function person(role: 'viewer' | 'member'): Promise<string> {
  const id = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  await createTestProjectMember(harness.db, { userId: id, projectId, role });
  return id;
}

/** Every comment on the issue, and who each is credited to. */
async function commentsOnIssue(): Promise<Array<{ authorId: string }>> {
  return harness.db
    .select({ authorId: m.schema.comments.authorId })
    .from(m.schema.comments)
    .where(eq(m.schema.comments.issueId, issueId));
}

async function claimOne(externalId: string, adapter: 'web' | 'rocketchat') {
  const [window] = await m.windows.claimDueWindows({
    adapter,
    claimant: 'iss-17',
    limit: 1,
    venuePrefixes: [externalId],
    settleMs: 0,
  });
  if (!window) throw new Error(`no ${adapter} window was due for ${externalId}`);
  return window;
}

describe('a group web room', () => {
  async function askInGroupRoom(speaker: string): Promise<void> {
    const room = await m.store.openConversation({
      adapter: 'web',
      externalId: `web ${randomUUID()}`,
      shape: 'group',
      projectId,
    });
    await m.participants.addPerson({ conversationId: room.id, userId: ownerId });
    await m.participants.addPerson({ conversationId: room.id, userId: speaker });
    await m.collect.collectInboundMessage({
      ports: m.web.webConversationPorts,
      frame: {
        conversation: { id: room.id, externalId: room.externalId, shape: 'group' },
        projectId,
        userId: speaker,
      },
      message: `@${handle.handle} please add a comment on the issue`,
      speakerKey: speaker,
      speakerLabel: 'Someone',
    } as never);
    const window = await claimOne(room.externalId, 'web');
    await m.send.routeWebWindow(window, m.windows.claimOf(window) as never);
  }

  it('refuses a viewer’s write by name, and nothing is written as anyone', async () => {
    const viewer = await person('viewer');

    await askInGroupRoom(viewer);

    expect(toolRuns).toHaveLength(1);
    expect(toolRuns[0]?.isError).toBe(true);
    expect(toolRuns[0]?.text).toMatch(/viewer|read-only|FORBIDDEN|403/i);
    expect(await commentsOnIssue()).toEqual([]);
  });

  it('writes a member’s ask as that member, not as the room’s handle', async () => {
    const member = await person('member');

    await askInGroupRoom(member);

    expect(toolRuns[0]?.isError, toolRuns[0]?.text).toBe(false);
    expect(await commentsOnIssue()).toEqual([{ authorId: member }]);
  });
});

describe('a Rocket.Chat group room', () => {
  const SERVER = 'https://chat.example.com';
  const RID = 'room-1';
  const delivered: string[] = [];

  beforeEach(() => {
    delivered.length = 0;
    m.ports.registerConversationTransport({
      adapter: 'rocketchat',
      deliver: async (_venue: unknown, message: { text: string }) => {
        delivered.push(message.text);
        return { messageId: `rc-${randomUUID()}` };
      },
    } as never);
  });

  async function askInChannel(rcUserId: string): Promise<void> {
    const connection = await m.rcStore.createConnection({
      ownerType: 'user',
      ownerId,
      provider: 'rocketchat',
      config: { serverUrl: SERVER },
      secrets: { authToken: 'tok', userId: 'bot' },
    });
    await m.rcStore.createBinding({
      connectionId: connection.id,
      projectId,
      provider: 'rocketchat',
      role: 'service',
      config: { rids: [RID] },
    });
    const routes = await m.rcRoutes.buildRoutes(connection.id);
    const frame = {
      m: { id: `msg-${randomUUID()}`, rid: RID, userId: rcUserId, username: 'stranger', text: '' },
      auth: { serverUrl: SERVER, authToken: 'tok', userId: 'bot' },
      projectId,
      shape: 'group' as const,
    };
    await m.collect.collectInboundMessage({
      ports: m.rcPort.rocketChatConversationPorts,
      frame,
      message: `@${handle.handle} please add a comment on the issue`,
      speakerKey: rcUserId,
      speakerLabel: 'stranger',
      externalMessageId: frame.m.id,
    } as never);
    const externalId = m.rcPort.rocketChatVenueId('chat.example.com', RID);
    const window = await claimOne(externalId, 'rocketchat');
    const ac = {
      routes,
      serverUrl: SERVER,
      authToken: 'tok',
      botUserId: 'bot',
      botName: handle.handle,
      closing: false,
    };
    await m.rcDrain.routeOne(() => ac as never, connection.id, window as never, undefined);
  }

  it('refuses a sender linked to no Forge account by name, and never acts as the org’s creator', async () => {
    await askInChannel('rc-stranger');

    expect(toolRuns).toEqual([]);
    expect(await commentsOnIssue()).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/link/i);
  });

  it('writes a linked sender’s ask as the Forge account they are linked to', async () => {
    const member = await person('member');
    await harness.db.insert(m.links.assistantSpeakerLinks).values({
      source: 'rocketchat',
      externalNamespace: 'chat.example.com',
      externalId: 'rc-linked',
      userId: member,
      confirmedVia: 'channel_email_match',
    });

    await askInChannel('rc-linked');

    expect(toolRuns[0]?.isError, toolRuns[0]?.text).toBe(false);
    expect(await commentsOnIssue()).toEqual([{ authorId: member }]);
  });
});

describe('a person who sent their message with an access token', () => {
  async function askDirectly(speaker: string, viaTokenId: string) {
    const room = await m.store.openConversation({
      adapter: 'web',
      externalId: `web ${randomUUID()}`,
      shape: 'direct',
      projectId,
    });
    await m.participants.addPerson({ conversationId: room.id, userId: speaker });
    await m.collect.collectInboundMessage({
      ports: m.web.webConversationPorts,
      frame: {
        conversation: { id: room.id, externalId: room.externalId, shape: 'direct' },
        projectId,
        userId: speaker,
      },
      message: 'please add a comment on the issue',
      speakerKey: speaker,
      speakerLabel: 'Member',
      speakerTokenId: viaTokenId,
    });
    return room;
  }

  const lastReply = async (conversationId: string) =>
    (await m.store.readMessages(conversationId, 10)).filter((x) => x.role === 'assistant').at(-1)
      ?.content ?? null;

  it('is bounded by its grant: a token granted less than everything does not reach the CLI', async () => {
    const member = await person('member');
    const { mintPat } = await import('../../src/auth/pat.js');
    const pat = await mintPat({
      userId: member,
      name: 'narrow',
      permissions: ['assistant:write', 'issues:write'],
    });
    const room = await askDirectly(member, pat.row.id);
    const window = await claimOne(room.externalId, 'web');
    await m.send.routeWebWindow(window, m.windows.claimOf(window) as never);

    expect(toolRuns[0]?.isError).toBe(true);
    expect(toolRuns[0]?.text).toMatch(/granted only assistant:write, issues:write/);
    expect(await commentsOnIssue()).toEqual([]);
  });

  it('is refused by name where that token was revoked before the turn acted', async () => {
    const member = await person('member');
    const { mintPat, revokePat } = await import('../../src/auth/pat.js');
    const pat = await mintPat({ userId: member, name: 'soon-gone', permissions: ['*'] });
    const room = await askDirectly(member, pat.row.id);
    await revokePat(pat.row.id, member);
    const window = await claimOne(room.externalId, 'web');
    await m.send.routeWebWindow(window, m.windows.claimOf(window) as never);

    expect(toolRuns).toEqual([]);
    expect(await commentsOnIssue()).toEqual([]);
    expect(await lastReply(room.id)).toMatch(/revoked or has expired/);
  });
});

describe('the token a turn ran under', () => {
  it('is revoked when the turn ends', async () => {
    const member = await person('member');
    const room = await m.store.openConversation({
      adapter: 'web',
      externalId: `web ${randomUUID()}`,
      shape: 'direct',
      projectId,
    });
    await m.participants.addPerson({ conversationId: room.id, userId: member });
    await m.collect.collectInboundMessage({
      ports: m.web.webConversationPorts,
      frame: {
        conversation: { id: room.id, externalId: room.externalId, shape: 'direct' },
        projectId,
        userId: member,
      },
      message: 'please add a comment on the issue',
      speakerKey: member,
      speakerLabel: 'Member',
    } as never);
    const window = await claimOne(room.externalId, 'web');
    await m.send.routeWebWindow(window, m.windows.claimOf(window) as never);

    const tokens = await harness.db
      .select({ revokedAt: m.schema.personalAccessTokens.revokedAt })
      .from(m.schema.personalAccessTokens)
      .where(and(eq(m.schema.personalAccessTokens.userId, member)));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
  });
});
