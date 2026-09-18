import { describe, expect, it } from 'vitest';
import { problemsOf } from '../../messaging/contract.js';
import { screenCarriedComment } from './comment-carry.js';
import { threadRootText } from './comment-render.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { decideSkip } from './inbound-gate.js';

const msg = (over: Partial<RocketChatIncomingMessage> = {}): RocketChatIncomingMessage =>
  ({
    id: 'm1',
    rid: 'room-1',
    text: 'a reply on a root nobody registered',
    userId: 'person',
    username: 'person',
    ...over,
  }) as RocketChatIncomingMessage;

describe('the root that opens an issue thread', () => {
  it('names the issue and its title, so the room can tell what the thread is about', () => {
    const root = threadRootText('ISS-981', 'An issue comments and a chat thread are one');
    expect(root).toContain('ISS-981');
    expect(root).toContain('An issue comments and a chat thread are one');
  });
});

describe('a comment carried into a room', () => {
  it('refuses one that would page the whole room', () => {
    for (const shout of ['@all ship it', 'please look @here', 'hey @channel']) {
      const verdict = screenCarriedComment(shout);
      expect(verdict.ok).toBe(false);
      expect(problemsOf(verdict).join(' ')).toContain('addresses the whole room');
    }
  });

  it('refuses one with nothing in it', () => {
    expect(screenCarriedComment('   ').ok).toBe(false);
  });

  it('allows a multi-line comment, which a question round may not be', () => {
    expect(screenCarriedComment('first line\nsecond line').ok).toBe(true);
  });

  it('does not read an address inside a word as a broadcast', () => {
    expect(screenCarriedComment('mail me at all@example.com').ok).toBe(true);
  });
});

// cm:guard the residual the at-least-once root leaves, asserted rather than wished away: a reply on an orphan root DOES reach the conversation path, and a change that made this go red would be a change to ordinary conversation routing (ISS-981 criterion 34). ISS-1004 made the residual LARGER rather than smaller — the reply used to need the bot's name in a group room and now needs nothing — so the assertion is the same one with the mention arm gone.
describe('a reply on a root the registry does not know', () => {
  it('reaches the conversation path in every room shape', () => {
    expect(decideSkip(msg({ tmid: 'orphan' }), 'bot')).toBeNull();
  });

  it('is still refused when it is the bot own message', () => {
    expect(decideSkip(msg({ tmid: 'orphan', userId: 'bot' }), 'bot')).toBe('own-message');
  });
});
