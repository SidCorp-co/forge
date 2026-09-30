// ISS-17 — who a runner-hosted conversation turn acts as: the asker, on a box that carries
// their token. The mocks are `conversation-agent.test.ts`'s, which is at its size budget.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../pipeline/outbox-session.js', () => ({ withActorContext: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(),
  setCurrentStepForOpenIssueRun: vi.fn(),
}));

const computeProjectProgress = vi.fn(async (..._args: unknown[]) => null);
vi.mock('../issues/progress.js', () => ({
  computeProjectProgress: (...args: unknown[]) => computeProjectProgress(...args),
  buildProgressFactsBlock: () => 'PROGRESS FACTS BLOCK',
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
vi.mock('./chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
}));

const resolveSessionAuthority = vi.fn();
const mintSessionCredential = vi.fn(async (..._args: unknown[]) => 'forge_pat_dev_turn');
vi.mock('./session-credential.js', async (orig) => ({
  ...(await orig<typeof import('./session-credential.js')>()),
  resolveSessionAuthority: (...args: unknown[]) => resolveSessionAuthority(...args),
  mintSessionCredential: (...args: unknown[]) => mintSessionCredential(...args),
}));

const applyKernelTransition = vi.fn();
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransition(...args),
}));

const findAvailableDeviceForProject = vi.fn();
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (...args: unknown[]) => findAvailableDeviceForProject(...args),
}));

const deliver = vi.fn(async () => ({ messageId: 'm1' }));
vi.mock('../conversations/ports.js', async (orig) => ({
  ...(await orig<typeof import('../conversations/ports.js')>()),
  conversationTransport: () => ({ adapter: 'web', deliver }),
}));

const loadConversationAttachment = vi.fn();
vi.mock('../conversations/attachment-service.js', async (orig) => ({
  ...(await orig<typeof import('../conversations/attachment-service.js')>()),
  loadConversationAttachment: (...args: unknown[]) => loadConversationAttachment(...args),
}));

const storageGet = vi.fn();
vi.mock('../storage/index.js', () => ({ getStorage: () => ({ get: storageGet }) }));

const persistSessionAttachment = vi.fn();
vi.mock('./attachment-service.js', () => ({
  persistSessionAttachment: (...args: unknown[]) => persistSessionAttachment(...args),
}));

const loggerInfo = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: (...args: unknown[]) => loggerInfo(...args), error: vi.fn(), warn: vi.fn() },
}));

const { startConversationAgentTurn } = await import('./conversation-agent.js');

const VENUE = {
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.com room-1',
  shape: 'direct' as const,
  projectId: 'proj-1',
};

const ACK_DELAY_MS = 2 * 60 * 1000;
const ACK = 'Babo is working on this.';

const REPLIES = {
  dedup: 'already running',
  noDevice: 'no box free',
  failed: 'nothing to show you',
  ack: ACK,
};

const BASE_ARGS = {
  venue: VENUE,
  conversationId: 'conv-1',
  windowId: 'win-1',
  deliveryKey: 'key-1',
  project: { id: 'proj-1', slug: 'proj', repoPath: '/repo' },
  handleName: 'Babo',
  question: 'How does the pipeline dispatcher work?',
  askedByLabel: '@alice',
  persona: 'PERSONA',
  conversationContext: 'earlier discussion…',
  door: 'agent-chat-completion' as const,
  replies: REPLIES,
  ackAfterMs: ACK_DELAY_MS,
  forceLenses: ['product'] as const,
  asker: {
    userId: 'alice-id',
    projectId: 'proj-1',
    viaTokenId: null,
    grant: null,
    scopes: ['read', 'write'],
    grantEpoch: 2,
  },
};

const AUTHORISED = { ok: true, value: { authority: BASE_ARGS.asker, menu: ['issues:write'] } };

/** A box that declared it carries the asker's token is free; so is every box. */
function boxFree(deviceId: string | null) {
  findAvailableDeviceForProject.mockImplementation(async () => deviceId);
}

describe('startConversationAgentTurn · who the session acts as (ISS-17)', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    findAvailableDeviceForProject.mockReset();
    resolveSessionAuthority.mockReset();
    resolveSessionAuthority.mockResolvedValue(AUTHORISED);
    mintSessionCredential.mockClear();
  });

  function readyToDispatch() {
    selectLimit.mockResolvedValue([]);
    boxFree('device-1');
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-1' });
  }

  it('runs the session as the asker: their userId on the row, their token on the dispatch', async () => {
    readyToDispatch();

    await startConversationAgentTurn(BASE_ARGS);

    expect(findAvailableDeviceForProject).toHaveBeenCalledWith('proj-1', {
      excludeDeviceIds: [],
      requireCapability: 'turnCredential',
    });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'alice-id',
        metadata: expect.objectContaining({
          conversationAgent: expect.objectContaining({
            asker: { userId: 'alice-id', viaTokenId: null },
          }),
        }),
      }),
    );
    expect(mintSessionCredential).toHaveBeenCalledWith({
      sessionId: 'session-1',
      deviceId: 'device-1',
      value: AUTHORISED.value,
    });
    expect(dispatchChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ credential: 'forge_pat_dev_turn' }),
    );
  });

  it('refuses by name, creating no session, where the only free box cannot carry the token', async () => {
    selectLimit.mockResolvedValue([]);
    findAvailableDeviceForProject.mockImplementation(
      async (_p: string, o: { requireCapability?: string }) =>
        o.requireCapability ? null : 'old-box',
    );

    const result = await startConversationAgentTurn(BASE_ARGS);

    expect(result).toEqual({ started: false, reason: 'runner-outdated' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('refuses by name, creating no session, where the asker may not be acted as on that box', async () => {
    readyToDispatch();
    resolveSessionAuthority.mockResolvedValue({
      ok: false,
      refusal: { code: 'TURN_NO_ROLE', message: 'no role here' },
    });

    const result = await startConversationAgentTurn(BASE_ARGS);

    expect(result).toEqual({
      started: false,
      reason: 'authority-refused',
      message: 'no role here',
    });
    expect(createChatSessionRow).not.toHaveBeenCalled();
    expect(mintSessionCredential).not.toHaveBeenCalled();
  });
});
