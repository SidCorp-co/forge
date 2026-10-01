/**
 * ISS-23 — a reply telling a refused write as done reaches the person with a correction under it,
 * through the web room and the Rocket.Chat room alike. Only the model is replaced: it reports a
 * refused `forge_channel` submit and says what the next case chooses.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { seedBinding } from '../helpers/seed-binding.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const DRAFT = '0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b';
const CORRECTION = `Correction: the submit of ${DRAFT} was refused (CHANNEL_WRITE_NOT_AUTHORISED); nothing was written.`;
const said = { reply: '' };

vi.mock('../../src/assistant/external-chat.js', async (orig) => {
  const actual = await orig<typeof import('../../src/assistant/external-chat.js')>();
  return {
    ...actual,
    runExternalChatTurn: vi.fn(async () => ({
      conversationId: null,
      assistantMessageId: null,
      reply: said.reply,
      terminal: 'done',
      error: null,
      iterations: 2,
      toolCalls: [
        {
          name: 'forge_channel',
          arguments: JSON.stringify({ action: 'submit', ref: DRAFT }),
          isError: true,
          refusalCode: 'CHANNEL_WRITE_NOT_AUTHORISED',
        },
      ],
      progress: null,
    })),
  };
});

vi.mock('../../src/integrations/rocketchat/context.js', async (orig) => ({
  ...(await orig<typeof import('../../src/integrations/rocketchat/context.js')>()),
  buildConversationContext: vi.fn(async () => null),
}));

let harness: TestDatabase;
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
  links: typeof import('../../src/db/schema-speaker-links.js');
};
let ownerId: string;
let projectId: string;
let handle: { userId: string; handle: string };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abcdef';
  process.env.NODE_ENV ??= 'test';
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
    links: await import('../../src/db/schema-speaker-links.js'),
  };
}, 180_000);

afterAll(async () => {
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  m.ports.registerConversationTransport(m.web.webConversationPorts);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  handle = await harness.db.transaction((tx) =>
    m.handles.resolveProjectHandle(tx as never, projectId),
  );
});

async function claimOne(externalId: string, adapter: 'web' | 'rocketchat') {
  const [window] = await m.windows.claimDueWindows({
    adapter,
    claimant: 'iss-23',
    limit: 1,
    venuePrefixes: [externalId],
    settleMs: 0,
  });
  if (!window) throw new Error(`no ${adapter} window was due for ${externalId}`);
  return window;
}

async function webReply(): Promise<string | null> {
  const room = await m.store.openConversation({
    adapter: 'web',
    externalId: `web ${randomUUID()}`,
    shape: 'direct',
    projectId,
  });
  await m.participants.addPerson({ conversationId: room.id, userId: ownerId });
  await m.collect.collectInboundMessage({
    ports: m.web.webConversationPorts,
    frame: {
      conversation: { id: room.id, externalId: room.externalId, shape: 'direct' },
      projectId,
      userId: ownerId,
    },
    message: 'please send the change notice',
    speakerKey: ownerId,
    speakerLabel: 'Owner',
  } as never);
  const window = await claimOne(room.externalId, 'web');
  await m.send.routeWebWindow(window, m.windows.claimOf(window) as never);
  return (
    (await m.store.readMessages(room.id, 10)).filter((x) => x.role === 'assistant').at(-1)
      ?.content ?? null
  );
}

async function roomReply(): Promise<string[]> {
  const SERVER = 'https://chat.example.com';
  const RID = 'room-1';
  const delivered: string[] = [];
  m.ports.registerConversationTransport({
    adapter: 'rocketchat',
    deliver: async (_venue: unknown, message: { text: string }) => {
      delivered.push(message.text);
      return { messageId: `rc-${randomUUID()}` };
    },
  } as never);
  await harness.db.insert(m.links.assistantSpeakerLinks).values({
    source: 'rocketchat',
    externalNamespace: 'chat.example.com',
    externalId: 'rc-owner',
    userId: ownerId,
    confirmedVia: 'channel_email_match',
  });
  const connection = await m.rcStore.createConnection({
    ownerType: 'user',
    ownerId,
    provider: 'rocketchat',
    config: { serverUrl: SERVER },
    secrets: { authToken: 'tok', userId: 'bot' },
  });
  await seedBinding({
    connectionId: connection.id,
    projectId,
    provider: 'rocketchat',
    role: 'service',
    config: { rids: [RID] },
  });
  const routes = await m.rcRoutes.buildRoutes(connection.id);
  const frame = {
    m: { id: `msg-${randomUUID()}`, rid: RID, userId: 'rc-owner', username: 'owner', text: '' },
    auth: { serverUrl: SERVER, authToken: 'tok', userId: 'bot' },
    projectId,
    shape: 'group' as const,
  };
  await m.collect.collectInboundMessage({
    ports: m.rcPort.rocketChatConversationPorts,
    frame,
    message: `@${handle.handle} please send the change notice`,
    speakerKey: 'rc-owner',
    speakerLabel: 'owner',
    externalMessageId: frame.m.id,
  } as never);
  const window = await claimOne(m.rcPort.rocketChatVenueId('chat.example.com', RID), 'rocketchat');
  const ac = {
    routes,
    serverUrl: SERVER,
    authToken: 'tok',
    botUserId: 'bot',
    botName: handle.handle,
    closing: false,
  };
  await m.rcDrain.routeOne(() => ac as never, connection.id, window as never, undefined);
  return delivered;
}

describe('a refused submit told as sent', () => {
  beforeEach(() => {
    said.reply = 'The change notice has been sent to the plugin team.';
  });

  it('reaches the web room with the correction under it', async () => {
    const reply = await webReply();
    expect(reply).toContain('has been sent');
    expect(reply).toContain(CORRECTION);
  });

  it('reaches the Rocket.Chat room with the correction under it', async () => {
    const delivered = await roomReply();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(CORRECTION);
  });
});

describe('an honest reply after the same refused submit', () => {
  beforeEach(() => {
    said.reply = 'I could not send it: the channel refused the submit, so nothing went out.';
  });

  it('reaches both rooms as the model wrote it, with no correction', async () => {
    expect(await webReply()).toBe(said.reply);
    expect(await roomReply()).toEqual([said.reply]);
  });
});
