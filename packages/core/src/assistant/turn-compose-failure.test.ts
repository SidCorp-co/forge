import { describe, expect, it, vi } from 'vitest';
import { TurnBlockStage } from './turn-stage.js';

const silences: unknown[] = [];
/** What the scripted model's first attempt ends as, and what the screen makes of it. */
const script: { terminal: 'done' | 'error'; reply: string; screen: unknown } = {
  terminal: 'error',
  reply: '',
  screen: { said: null, failed: null },
};

vi.mock('../conversations/index.js', async () => {
  const replies = await import('../conversations/text-language.js');
  return {
    ...replies,
    screened: (text: string) => ({ text, proof: null }),
    codeAuthored: (text: string) => ({ text, authored: 'code' }),
    recordSilence: async (row: unknown) => {
      silences.push(row);
    },
  };
});
vi.mock('../lib/data-egress.js', () => ({ egressDeep: async () => ({ ok: true, value: null }) }));
vi.mock('./external-chat.js', () => ({
  runExternalChatTurn: async () => ({
    conversationId: 'c-1',
    reply: script.reply,
    terminal: script.terminal,
    error: script.terminal === 'error' ? 'AbortError: This operation was aborted' : null,
    iterations: 3,
    toolCalls: [],
    progress: null,
  }),
}));
vi.mock('./confab.js', () => ({ correctFalseClaims: (text: string) => ({ text }) }));
vi.mock('./screened-reply.js', () => ({
  declinedTail: () => '',
  declinedTurn: () => false,
  screenedTurnReply: async () => script.screen,
}));
vi.mock('./tools/room-send-tool.js', () => ({ roomSendCapture: () => null }));
vi.mock('./tools/mcp-adapter.js', () => ({ mergeToolsets: () => undefined }));
vi.mock('../credentials/turn-credential.js', () => ({ turnAuthorityRefusalOf: () => null }));

const { composeReply } = await import('./turn-compose.js');
const { TURN_TIMED_OUT } = await import('./conversation-stops.js');

function ctxWith(abortReason: unknown, mayDecline = true) {
  const abort = new AbortController();
  if (abortReason !== undefined) abort.abort(abortReason);
  return {
    req: {
      venue: { adapter: 'web', externalId: 'room-1', shape: 'direct', projectId: 'p-1' },
      authority: { userId: 'u-1', origin: 'message' },
      handleName: 'catalog-api',
      message: 'please draw the designs',
      mayDecline,
      sendMode: 'reply',
      questionAlreadyRecorded: true,
    },
    conversationId: 'c-1',
    abort,
    setPhase: () => undefined,
    draft: { text: '' },
    stage: new TurnBlockStage(),
    credential: async () => {
      throw new Error('no token in this test');
    },
  } as never;
}

describe('a turn that ends in an error is a coded failure, never a declined silence', () => {
  it('the 90-second ceiling reads as ASSISTANT_TURN_TIMED_OUT and records no silence row', async () => {
    silences.length = 0;
    const reply = await composeReply(ctxWith(TURN_TIMED_OUT));
    expect(reply).toMatchObject({ send: false, ended: 'failed', code: 'ASSISTANT_TURN_TIMED_OUT' });
    expect(JSON.stringify(reply)).not.toContain('AbortError');
    expect(silences).toEqual([]);
  });

  it('any other error reads as ASSISTANT_TURN_FAILED', async () => {
    const reply = await composeReply(ctxWith(new Error('upstream reset')));
    expect(reply).toMatchObject({ send: false, ended: 'failed', code: 'ASSISTANT_TURN_FAILED' });
  });
});

// ISS-875: core speaks only where the agent cannot. A screen that let nothing out is the agent's own
// silence, never a code-authored line in its place; a rewrite the provider broke off is a failure.
describe('a reply the screen let nothing of out', () => {
  it('is a silence the window records, with no line written for the agent', async () => {
    silences.length = 0;
    Object.assign(script, {
      terminal: 'done',
      reply: 'We are 87% done.',
      screen: { said: null, failed: null },
    });
    const reply = await composeReply(ctxWith(undefined, false));
    expect(reply).toEqual({ send: false, reason: 'screen-refused', ended: 'declined' });
    expect(silences).toHaveLength(1);
  });

  it('that the model left empty is a silence too, never "could you rephrase it"', async () => {
    Object.assign(script, { terminal: 'done', reply: '', screen: { said: null, failed: null } });
    const reply = await composeReply(ctxWith(undefined, false));
    expect(reply).toMatchObject({ send: false, reason: 'empty-reply', ended: 'declined' });
  });

  it('whose rewrite the provider broke off is the failure the person is told of', async () => {
    const broken = { reply: '', terminal: 'error', errorSource: 'provider', toolCalls: [] };
    Object.assign(script, {
      terminal: 'done',
      reply: 'We are 87% done.',
      screen: { said: null, failed: broken },
    });
    const reply = await composeReply(ctxWith(undefined, false));
    expect(reply).toMatchObject({ send: false, ended: 'failed', code: 'ASSISTANT_TURN_FAILED' });
    expect(reply).not.toHaveProperty('report');
    Object.assign(script, { terminal: 'error', reply: '', screen: { said: null, failed: null } });
  });
});
