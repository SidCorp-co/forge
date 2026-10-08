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
let ends: 'answer' | 'decline' = 'answer';

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
    if (ends === 'decline') return { send: false, reason: 'nothing-to-say', ended: 'declined' };
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

const run = () =>
  runConversationTurn({
    door: 'web-chat-reply',
    venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
    authority: { origin: 'message' },
    message: 'where does REQ-1 stand?',
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
