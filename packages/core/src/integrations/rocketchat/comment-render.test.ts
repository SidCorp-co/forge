import { describe, expect, it } from 'vitest';
import { threadRootText } from './comment-render.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import { decideHandling } from './inbound-gate.js';
import { screenCarriedComment } from './reply-guard.js';

const msg = (over: Partial<RocketChatIncomingMessage> = {}): RocketChatIncomingMessage =>
  ({
    id: 'm1',
    rid: 'room-1',
    text: 'a reply on a root nobody registered',
    userId: 'person',
    username: 'person',
    mentions: [],
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
      expect(verdict.problems.join(' ')).toContain('addresses the whole room');
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

describe('a reply on a root the registry does not know', () => {
  it('is dropped in a group room when it does not mention the bot', () => {
    const verdict = decideHandling(msg({ tmid: 'orphan' }), 'bot', 'group', false);
    expect(verdict.handle).toBe(false);
    expect(verdict.reason).toBe('not-mentioned');
  });

  // cm:guard these two are the residual the at-least-once root leaves, asserted rather than wished away: a reply on an orphan root DOES reach the conversation handler in a direct room or when it mentions the bot, and a change that made this test go red would be a change to ordinary conversation routing (ISS-981 criterion 34).
  it('still reaches the conversation handler in a direct room', () => {
    expect(decideHandling(msg({ tmid: 'orphan' }), 'bot', 'direct', false).handle).toBe(true);
  });

  it('still reaches the conversation handler when it mentions the bot', () => {
    expect(
      decideHandling(msg({ tmid: 'orphan', mentions: ['bot'] }), 'bot', 'group', false).handle,
    ).toBe(true);
  });
});
