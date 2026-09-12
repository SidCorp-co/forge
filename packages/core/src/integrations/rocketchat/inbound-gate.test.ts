import { describe, expect, it } from 'vitest';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideHandling, decideSkip } from './inbound-gate.js';

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
    images: [],
    ...over,
  };
}

describe('decideHandling in a group room', () => {
  it('handles a mention from another user', () => {
    expect(decideHandling(msg({}), BOT, 'group')).toEqual({ handle: true, reason: 'ok' });
  });
  it('ignores the bot own messages (loop guard)', () => {
    expect(decideHandling(msg({ userId: BOT }), BOT, 'group').handle).toBe(false);
  });
  it('ignores system + edited messages', () => {
    expect(decideHandling(msg({ isSystem: true }), BOT, 'group').handle).toBe(false);
    expect(decideHandling(msg({ isEdited: true }), BOT, 'group').handle).toBe(false);
  });
  it('ignores empty text', () => {
    expect(decideHandling(msg({ text: '   ' }), BOT, 'group').handle).toBe(false);
  });
  it('ignores messages that do not mention the bot', () => {
    expect(decideHandling(msg({ mentions: ['other'] }), BOT, 'group').reason).toBe('not-mentioned');
  });
  it('still requires the mention inside a thread', () => {
    expect(
      decideHandling(msg({ mentions: ['other'], tmid: 'thread-a' }), BOT, 'group').reason,
    ).toBe('not-mentioned');
  });
});

// cm:why the deliverable is the DIFFERENCE between the two shapes on one unchanged message, so both halves are asserted on the same text: either assertion alone passes with the shape ignored entirely (ISS-987 criteria 1, 2, 3)
describe('decideHandling in a direct room', () => {
  const unaddressed = msg({ text: 'how does the pipeline work?', mentions: [] });

  it('handles a message that mentions nobody', () => {
    expect(decideHandling(unaddressed, BOT, 'direct')).toEqual({ handle: true, reason: 'ok' });
  });

  it('is the shape alone that decides it — the same message is refused in a group room', () => {
    expect(decideHandling(unaddressed, BOT, 'group')).toEqual({
      handle: false,
      reason: 'not-mentioned',
    });
  });

  it('still skips the bot own messages, so a DM cannot become a loop', () => {
    expect(decideHandling(msg({ userId: BOT, mentions: [] }), BOT, 'direct').reason).toBe(
      'own-message',
    );
  });

  it('still skips system events', () => {
    expect(decideHandling(msg({ isSystem: true, mentions: [] }), BOT, 'direct').reason).toBe(
      'system',
    );
  });

  it('still skips edits', () => {
    expect(decideHandling(msg({ isEdited: true, mentions: [] }), BOT, 'direct').reason).toBe(
      'edited',
    );
  });

  it('still skips empty text', () => {
    expect(decideHandling(msg({ text: '   ', mentions: [] }), BOT, 'direct').reason).toBe('empty');
  });

  it('handles an unmentioned message inside a thread in a direct room', () => {
    expect(decideHandling(msg({ mentions: [], tmid: 'thread-a' }), BOT, 'direct').handle).toBe(
      true,
    );
  });
});

describe('decideSkip', () => {
  it('answers null for a message no shape-free rule rejects, so the caller pays for a shape', () => {
    expect(decideSkip(msg({ mentions: [] }), BOT)).toBeNull();
  });

  it('names the rule for each shape-free rejection', () => {
    expect(decideSkip(msg({ userId: BOT }), BOT)).toBe('own-message');
    expect(decideSkip(msg({ isSystem: true }), BOT)).toBe('system');
    expect(decideSkip(msg({ isEdited: true }), BOT)).toBe('edited');
    expect(decideSkip(msg({ text: '' }), BOT)).toBe('empty');
  });

  it('does not reject an unmentioned message, which is addressing and not a skip', () => {
    expect(decideSkip(msg({ mentions: ['other'] }), BOT)).toBeNull();
  });
});

describe('createSeenTracker', () => {
  it('flags the second delivery of the same message id (URL-preview re-emit)', () => {
    const seen = createSeenTracker();
    expect(seen('m1')).toBe(false);
    expect(seen('m1')).toBe(true);
    expect(seen('m2')).toBe(false);
  });

  it('prunes oldest ids past the cap but keeps recent ones', () => {
    const seen = createSeenTracker(10);
    for (let i = 0; i < 11; i++) seen(`m${i}`);
    expect(seen('m0')).toBe(false);
    expect(seen('m10')).toBe(true);
  });
});
