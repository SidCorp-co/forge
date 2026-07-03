import { describe, expect, it } from 'vitest';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { decideHandling } from './inbound-gate.js';

const BOT = 'bot-id';
function msg(over: Partial<RocketChatIncomingMessage>): RocketChatIncomingMessage {
  return {
    id: 'm',
    rid: 'r',
    text: '@bot hi',
    userId: 'someone',
    isSystem: false,
    isEdited: false,
    mentions: [BOT],
    ...over,
  };
}

describe('decideHandling', () => {
  it('handles a mention from another user', () => {
    expect(decideHandling(msg({}), BOT)).toEqual({ handle: true, reason: 'ok' });
  });
  it('ignores the bot own messages (loop guard)', () => {
    expect(decideHandling(msg({ userId: BOT }), BOT).handle).toBe(false);
  });
  it('ignores system + edited messages', () => {
    expect(decideHandling(msg({ isSystem: true }), BOT).handle).toBe(false);
    expect(decideHandling(msg({ isEdited: true }), BOT).handle).toBe(false);
  });
  it('ignores empty text', () => {
    expect(decideHandling(msg({ text: '   ' }), BOT).handle).toBe(false);
  });
  it('ignores messages that do not mention the bot', () => {
    expect(decideHandling(msg({ mentions: ['other'] }), BOT).reason).toBe('not-mentioned');
  });
});
