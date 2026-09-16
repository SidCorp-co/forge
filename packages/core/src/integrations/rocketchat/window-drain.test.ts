/**
 * What the drain does with a window it has already claimed.
 *
 * The claim is the easy half and is proved against a real Postgres in
 * `tests/integration/conversation-window-e2e.test.ts`. What is under test here
 * is the half that runs between the claim and the turn: whether the connection
 * that claimed is still the one that may answer, and what the room's own words
 * look like by the time a model is shown them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const routeWindow = vi.fn(async (_args?: unknown) => ({ decision: 'answered' as const }));
vi.mock('../../conversations/route-window.js', () => ({
  routeWindow: (...a: unknown[]) => routeWindow(...(a as [])),
}));

const releaseWindow = vi.fn(async () => undefined);
const claimDueWindows = vi.fn(async () => [] as unknown[]);
vi.mock('../../conversations/windows.js', () => ({
  claimDueWindows: (...a: unknown[]) => claimDueWindows(...(a as [])),
  releaseWindow: (...a: unknown[]) => releaseWindow(...(a as [])),
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
}));

const rocketChatTurn = vi.fn((_args?: unknown) => ({ door: 'chat-sync' }));
vi.mock('./turn-inputs.js', () => ({
  rocketChatTurn: (...a: unknown[]) => rocketChatTurn(...(a as [])),
}));

vi.mock('../../assistant/identity/directory.js', () => ({
  namespaceFromServerUrl: (url: string) => url.replace('https://', ''),
}));

const { drainConversationWindows, routeOne } = await import('./window-drain.js');

const ROUTE = {
  projectId: 'proj-1',
  principalUserId: 'user-1',
  projectSlug: 'p',
  projectName: 'P',
};

function connection(over: Record<string, unknown> = {}) {
  return {
    client: {},
    closing: false,
    botName: 'Babo',
    serverUrl: 'https://chat.example.co',
    authToken: 'tok',
    botUserId: 'bot-1',
    routes: new Map([['room-1', ROUTE]]),
    ...over,
  } as never;
}

function window(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    conversationId: 'c1',
    projectId: 'proj-1',
    adapter: 'rocketchat',
    venueExternalId: 'chat.example.co room-1',
    venueShape: 'group',
    openedAt: new Date(),
    extendedAt: new Date(),
    firstSeq: 0,
    lastSeq: 1,
    claimedAt: new Date('2026-09-14T09:00:00.000Z'),
    claimedBy: 'test:conn-1',
    deliveryReservedAt: null,
    closedAt: null,
    decision: null,
    decisionDetail: null,
    ...over,
  } as never;
}

function said(authorLabel: string, content: string, seq: number) {
  return {
    id: `m${seq}`,
    seq,
    role: 'user' as const,
    authorUserId: null,
    authorLabel,
    content,
    images: [],
    externalId: `rc-${seq}`,
    deliveryProof: null,
    silenceReason: null,
    createdAt: new Date(),
  };
}

/** Run the router once and give back the subject the adapter built for it. */
async function subjectFor(messages: ReturnType<typeof said>[]) {
  routeWindow.mockImplementationOnce(async (args?: unknown) => {
    const a = args as { inputs: (c: unknown) => unknown };
    a.inputs({
      venue: { shape: 'group' },
      messages,
      principalUserId: 'user-1',
      reserve: async () => true,
    });
    return { decision: 'answered' as const };
  });
  await routeOne(() => connection(), 'conn-1', window(), undefined);
  const built = rocketChatTurn.mock.calls[0]?.[0] as unknown as {
    subject: Record<string, unknown>;
  };
  return built.subject;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeWindow.mockResolvedValue({ decision: 'answered' as const });
});

describe('a window whose connection is no longer the live one', () => {
  it('is released rather than routed when the manager has replaced the connection', async () => {
    await routeOne(() => null, 'conn-1', window(), undefined);
    expect(routeWindow).not.toHaveBeenCalled();
    expect(releaseWindow).toHaveBeenCalledWith('w1', {
      claimedAt: expect.any(Date),
      claimedBy: 'test:conn-1',
    });
  });

  it('is released when the room is no longer bound to this project', async () => {
    const other = connection({ routes: new Map([['room-1', { ...ROUTE, projectId: 'proj-9' }]]) });
    await routeOne(() => other, 'conn-1', window(), undefined);
    expect(routeWindow).not.toHaveBeenCalled();
    expect(releaseWindow).toHaveBeenCalled();
  });

  it('is routed when the connection handed in is still the live one', async () => {
    await routeOne(() => connection(), 'conn-1', window(), undefined);
    expect(releaseWindow).not.toHaveBeenCalled();
    expect(routeWindow).toHaveBeenCalled();
  });

  it('stops routing the rest of a batch once the connection is torn down', async () => {
    const ac = connection();
    const conns = new Map([['conn-1', ac]]);
    claimDueWindows.mockResolvedValue([window({ id: 'w1' }), window({ id: 'w2' })]);
    routeWindow.mockImplementationOnce(async () => {
      conns.delete('conn-1');
      return { decision: 'answered' as const };
    });

    await drainConversationWindows(conns as never, undefined);

    expect(routeWindow).toHaveBeenCalledTimes(1);
    expect(releaseWindow).toHaveBeenCalledWith('w2', expect.anything());
  });
});

describe('the words a window hands the model', () => {
  it('joins one speaker plainly and names them as the asker', async () => {
    const subject = await subjectFor([
      said('alice', 'why is CI red?', 0),
      said('alice', 'on main specifically', 1),
    ]);
    expect(subject.text).toBe('why is CI red?\non main specifically');
    expect(subject.username).toBe('alice');
  });

  it('labels each line and names no asker when two people spoke', async () => {
    const subject = await subjectFor([
      said('alice', 'deploy production?', 0),
      said('bob', 'no, staging', 1),
    ]);
    expect(subject.text).toBe('alice: deploy production?\nbob: no, staging');
    expect(subject.username).toBeUndefined();
  });

  it('carries every collected message id and image, in order', async () => {
    const subject = await subjectFor([said('alice', 'one', 0), said('bob', 'two', 1)]);
    expect(subject.messageIds).toEqual(['rc-0', 'rc-1']);
  });
});
