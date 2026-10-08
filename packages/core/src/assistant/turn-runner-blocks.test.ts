// A chat turn's blocks reach the room only with the reply that releases them, handed to the
// transport with that reply; a block nobody will see is named on the turn's outcome, which the
// window's record carries (REQ-32 criteria 5 and 6).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedBlock } from '../lib/staged-block.js';

const table: StagedBlock = {
  text: '| Requirement |',
  block: {
    type: 'visual',
    visual: { v: 1, kind: 'table', columns: ['key'], source: { runId: 'r' } },
  },
  kind: 'table',
  runId: 'r',
  projectId: 'p-1',
  askerUserId: 'u-1',
};

const handed: { text: string; blocks: readonly StagedBlock[] }[] = [];
let failDelivery = false;
let ends: 'answer' | 'decline' | 'decline-late' = 'answer';

vi.mock('../conversations/index.js', () => ({
  codeAuthored: (text: string) => ({ text, proof: null }),
  conversationTransport: () => ({
    deliver: async (
      _venue: unknown,
      message: { text: string },
      opts?: { blocks?: readonly StagedBlock[] },
    ) => {
      if (failDelivery) throw new Error('the room is gone');
      handed.push({ text: message.text, blocks: opts?.blocks ?? [] });
      return { messageId: 'm-1' };
    },
  }),
  openConversation: async () => ({ id: 'c-1' }),
  recordDeliveredReply: async () => undefined,
  nothingMoreReply: () => 'nothing more to add',
  partialReplyWords: () => ({
    head: () => 'still working',
    did: 'did',
    read: () => 'read',
    nothingYet: 'nothing yet',
  }),
}));
vi.mock('./turn-compose.js', () => ({
  composeReply: async (ctx: {
    stage: {
      stage: { hold(b: StagedBlock): Promise<void> };
      settle(a: number | null): void;
      kept(): StagedBlock[];
    };
  }) => {
    await ctx.stage.stage.hold(table);
    if (ends === 'decline-late') await new Promise((r) => setTimeout(r, 60));
    if (ends !== 'answer') return { send: false, reason: 'nothing-to-say', ended: 'declined' };
    ctx.stage.settle(0);
    return {
      send: true,
      message: { text: 'REQ-1 is agreed.' },
      screenReplaced: false,
      blocks: ctx.stage.kept(),
    };
  },
}));
vi.mock('./screened-reply.js', () => ({ assertAnswerableDoor: () => undefined }));
vi.mock('../credentials/turn-credential.js', () => ({
  CHAT_TURN_MENU: [],
  mintTurnCredential: async () => ({ revoke: async () => undefined }),
}));
vi.mock('../lib/error-tracking.js', () => ({ reportFailure: () => undefined }));

const { runConversationTurn } = await import('./turn-runner.js');

const run = (budget?: { partialAfterMs: number; ceilingMs: number }) =>
  runConversationTurn({
    door: 'web-chat-reply',
    venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
    authority: { origin: 'message' },
    message: 'where does REQ-1 stand?',
    handleName: 'forge',
    ...(budget ? { budget } : {}),
  } as never);

beforeEach(() => {
  handed.length = 0;
  failDelivery = false;
  ends = 'answer';
});

describe("a chat turn's blocks go out with the reply that releases them", () => {
  it('hands the blocks to the transport with the reply, and names no drop', async () => {
    const outcome = await run();
    expect(handed).toEqual([{ text: 'REQ-1 is agreed.', blocks: [table] }]);
    expect(outcome).toMatchObject({ kind: 'delivered' });
    expect(outcome.droppedBlocks).toBeUndefined();
  });

  it('names the block on the outcome when the reply it was held with was not delivered', async () => {
    failDelivery = true;
    const outcome = await run();
    expect(outcome).toMatchObject({
      kind: 'undeliverable',
      droppedBlocks: [
        { kind: 'table', runId: 'r', why: 'the reply it was held with was not delivered' },
      ],
    });
  });

  it('names the block on the outcome of a turn that declined after drawing it', async () => {
    ends = 'decline';
    const outcome = await run();
    expect(handed).toEqual([]);
    expect(outcome).toMatchObject({
      kind: 'declined',
      droppedBlocks: [
        {
          kind: 'table',
          runId: 'r',
          why: 'the turn sent none of its own words (a code-authored line, or nothing), so nothing it drew is shown',
        },
      ],
    });
  });
});

describe('a turn that runs past its first ceiling', () => {
  it('names the block its rest drew and dropped on the rest, waited on until a stated bound', async () => {
    ends = 'decline-late';
    const started = Date.now();
    const outcome = await run({ partialAfterMs: 10, ceilingMs: 5000 });
    expect(outcome).toMatchObject({ kind: 'delivered' });
    const continuation = outcome.kind === 'delivered' ? outcome.continuation : undefined;
    expect(continuation, 'the turn outran its first ceiling').toBeDefined();
    // the ceiling, the 30 s a handle is given past its abort, and the 30 s its delivery is given
    const bound = (continuation?.until.getTime() ?? 0) - started;
    expect(bound).toBeGreaterThanOrEqual(65_000);
    expect(bound).toBeLessThan(66_000);
    expect(await continuation?.rest).toMatchObject({
      kind: 'delivered',
      droppedBlocks: [{ kind: 'table', runId: 'r' }],
    });
  });
});
