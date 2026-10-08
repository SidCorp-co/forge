// The blocks a chat turn draws wait on its reply (REQ-32 criteria 5 and 6): nothing is posted while
// the turn runs, the reply that passes releases its own answer's blocks, and a block drawn for an
// answer the screen refused is dropped by name unless the rewrite draws it again. The model is
// scripted, drawing through the stage its toolset is handed exactly as forge_show does; the screen
// judges each attempt with the blocks that attempt drew.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockStage, StagedBlock } from '../lib/staged-block.js';
import { TurnBlockStage } from './turn-stage.js';

const block = (title: string): StagedBlock => ({
  text: `**${title}**`,
  block: {
    type: 'visual',
    visual: { v: 1, kind: 'table', title, columns: ['key'], source: { runId: 'run-1' } },
  },
  kind: 'table',
  runId: 'run-1',
  projectId: 'p-1',
  askerUserId: 'u-1',
});

/** What each attempt of the scripted model draws, and whether the screen passes its reply. */
let script: { draws: StagedBlock[]; passes: boolean }[] = [];
const asked: string[] = [];
const judged: unknown[][] = [];
let drawOn: BlockStage | null = null;

vi.mock('../conversations/index.js', async () => {
  const replies = await import('../conversations/fallback-replies.js');
  return {
    ...replies,
    screened: (text: string) => ({ text, proof: { door: 'web-chat-reply' } }),
    codeAuthored: (text: string) => ({ text, proof: null }),
    recordSilence: async () => undefined,
  };
});
vi.mock('../lib/data-egress.js', () => ({ egressDeep: async () => ({ ok: true, value: null }) }));
vi.mock('./confab.js', () => ({ correctFalseClaims: (text: string) => ({ text }) }));
vi.mock('../credentials/turn-credential.js', () => ({ turnAuthorityRefusalOf: () => null }));
vi.mock('./external-chat.js', () => ({
  runExternalChatTurn: async (args: { message: string }) => {
    const attempt = asked.length;
    asked.push(args.message);
    for (const b of script[attempt]?.draws ?? []) await drawOn?.hold(b);
    return {
      conversationId: 'c-1',
      reply: `answer ${attempt}`,
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
      progress: null,
    };
  },
}));
vi.mock('../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: async (
    _door: string,
    input: { segments: string[]; heldBlocks?: unknown[] },
  ) => {
    judged.push(input.heldBlocks ?? []);
    const attempt = Number(/answer (\d+)/.exec(input.segments[0] ?? '')?.[1] ?? -1);
    return script[attempt]?.passes
      ? { ok: true, cell: 'role:chat' }
      : {
          ok: false,
          refusals: [
            {
              rule: 'no-empty-promise',
              why: 'the reply promises work it did not do',
              quote: null,
              shape: 'report the result you have',
              example: 'The deploy is done.',
            },
          ],
        };
  },
}));

const { composeReply } = await import('./turn-compose.js');

function ctx(stage: TurnBlockStage) {
  return {
    req: {
      venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
      authority: { userId: 'u-1', origin: 'message' },
      handleName: 'helper',
      door: 'web-chat-reply',
      message: 'where does REQ-1 stand?',
      mayDecline: false,
      sendMode: 'reply',
      questionAlreadyRecorded: true,
      prepare: async (hook: { blockStage: BlockStage }) => {
        drawOn = hook.blockStage;
        return {};
      },
    },
    conversationId: 'c-1',
    abort: new AbortController(),
    setPhase: () => undefined,
    draft: { text: '' },
    stage,
    credential: async () => {
      throw new Error('no token in this test');
    },
  } as never;
}

const first = block('Where REQ-1 stands');
const redrawn = block('REQ-1, read again');

beforeEach(() => {
  asked.length = 0;
  judged.length = 0;
  drawOn = null;
});

describe('the blocks a chat turn draws wait on its reply', () => {
  it('releases the blocks of a reply that passes, with the reply, judging it with them', async () => {
    script = [{ draws: [first], passes: true }];
    const stage = new TurnBlockStage('where does REQ-1 stand?');
    const reply = await composeReply(ctx(stage));
    expect(reply).toMatchObject({ send: true, message: { text: 'answer 0' }, blocks: [first] });
    expect(judged).toEqual([[first.block.visual]]);
    stage.released([first]);
    expect(stage.dropped()).toEqual([]);
  });

  it('drops, by name, a block the rewrite did not draw again, and tells the rewrite so', async () => {
    script = [
      { draws: [first], passes: false },
      { draws: [], passes: true },
    ];
    const stage = new TurnBlockStage('where does REQ-1 stand?');
    const reply = await composeReply(ctx(stage));
    expect(reply).toMatchObject({ send: true, message: { text: 'answer 1' } });
    expect((reply as { blocks?: unknown }).blocks).toBeUndefined();
    expect(asked[1]).toContain(
      'The 1 block(s) you drew for that answer (table) are held with it and will not be shown: call forge_show again for each block your rewrite keeps',
    );
    expect(judged).toEqual([[first.block.visual], []]);
    expect(stage.dropped()).toEqual([
      {
        kind: 'table',
        runId: 'run-1',
        why: 'it was drawn for an answer the reply check refused, and the rewrite that went out did not draw it again',
      },
    ]);
  });

  it("releases what the rewrite drew again and drops only the refused answer's block", async () => {
    script = [
      { draws: [first], passes: false },
      { draws: [redrawn], passes: true },
    ];
    const stage = new TurnBlockStage('where does REQ-1 stand?');
    const reply = await composeReply(ctx(stage));
    expect(reply).toMatchObject({ send: true, message: { text: 'answer 1' }, blocks: [redrawn] });
    stage.released([redrawn]);
    expect(stage.dropped().map((d) => d.why)).toEqual([
      'it was drawn for an answer the reply check refused, and the rewrite that went out did not draw it again',
    ]);
  });

  it('releases nothing when no answer passes and a code-authored line goes out instead', async () => {
    script = [
      { draws: [first], passes: false },
      { draws: [redrawn], passes: false },
    ];
    const stage = new TurnBlockStage('where does REQ-1 stand?');
    const reply = await composeReply(ctx(stage));
    expect(reply).toMatchObject({ send: true, message: { proof: null } });
    expect((reply as { blocks?: unknown }).blocks).toBeUndefined();
    expect(stage.dropped().map((d) => d.why)).toEqual([
      'the turn sent none of its own words (a code-authored line, or nothing), so nothing it drew is shown',
      'the turn sent none of its own words (a code-authored line, or nothing), so nothing it drew is shown',
    ]);
  });
});
