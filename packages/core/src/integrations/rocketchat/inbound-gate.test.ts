import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideSkip } from './inbound-gate.js';

const BOT = 'bot-id';
function msg(over: Partial<RocketChatIncomingMessage>): RocketChatIncomingMessage {
  return {
    id: 'm',
    rid: 'r',
    text: 'hi',
    userId: 'someone',
    isSystem: false,
    isEdited: false,
    images: [],
    ...over,
  };
}

describe('decideSkip', () => {
  it('answers null for a message no rule rejects', () => {
    expect(decideSkip(msg({}), BOT)).toBeNull();
  });

  it('names the rule for each rejection', () => {
    expect(decideSkip(msg({ userId: BOT }), BOT)).toBe('own-message');
    expect(decideSkip(msg({ isSystem: true }), BOT)).toBe('system');
    expect(decideSkip(msg({ isEdited: true }), BOT)).toBe('edited');
    expect(decideSkip(msg({ text: '' }), BOT)).toBe('empty');
  });

  it('admits a message that names nobody, in any room', () => {
    expect(decideSkip(msg({ text: 'how does the pipeline work?' }), BOT)).toBeNull();
    expect(
      decideSkip(msg({ text: 'anyone know why CI is red?', tmid: 'thread-a' }), BOT),
    ).toBeNull();
  });

  it('admits an image posted with no caption at all', () => {
    const shot = [{ name: 's.png', mime: 'image/png', ref: 'https://chat/f/s.png' }];
    expect(decideSkip(msg({ text: '   ', images: shot }), BOT)).toBeNull();
    expect(decideSkip(msg({ text: '   ', images: [] }), BOT)).toBe('empty');
  });

  it('holds the loop guard whatever the text says', () => {
    expect(decideSkip(msg({ userId: BOT, text: 'a perfectly ordinary sentence' }), BOT)).toBe(
      'own-message',
    );
  });
});

describe('the @-mention gate', () => {
  const SRC = join(import.meta.dirname, '..', '..');
  const FILES = [
    'integrations/rocketchat/inbound-gate.ts',
    'integrations/rocketchat/connection-manager.ts',
    'integrations/rocketchat/conversation-port.ts',
    'integrations/rocketchat/ddp-client.ts',
    'integrations/rocketchat/turn-inputs.ts',
    'conversations/collect-inbound.ts',
    'conversations/route-window.ts',
  ];

  it('is named by no module on the inbound path', () => {
    const offenders = FILES.filter((rel) => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const code = src
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      return /mentions/.test(code);
    });
    expect(offenders).toEqual([]);
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

describe('the duplicate tracker', () => {
  it('swallows a second sighting of the same id', () => {
    const seen = createSeenTracker();
    expect(seen('m1')).toBe(false);
    expect(seen('m1')).toBe(true);
  });

  it('gives an id back when the work it marked did not survive', () => {
    const seen = createSeenTracker();
    expect(seen('m1')).toBe(false);
    seen.forget('m1');
    expect(seen('m1')).toBe(false);
    expect(seen('m1')).toBe(true);
  });

  it('forgets an id it never held without complaining', () => {
    const seen = createSeenTracker();
    expect(() => seen.forget('never-seen')).not.toThrow();
  });
});
