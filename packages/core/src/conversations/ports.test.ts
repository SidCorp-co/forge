import { afterEach, describe, expect, it } from 'vitest';
import {
  clearConversationTransports,
  codeAuthored,
  type ConversationTransport,
  conversationTransport,
  registerConversationTransport,
  registeredConversationAdapters,
  screened,
} from './ports.js';

function fakeTransport(adapter: 'web' | 'telegram'): ConversationTransport {
  return {
    adapter,
    deliver: async (_venue, message) => ({ messageId: `${adapter}:${message.text}` }),
    fetchHistory: async () => [],
  };
}

afterEach(() => clearConversationTransports());

describe('the adapter registry', () => {
  it('serves a registered transport by its adapter name', () => {
    registerConversationTransport(fakeTransport('web'));
    expect(conversationTransport('web')?.adapter).toBe('web');
  });

  it('answers undefined for an adapter nothing registered', () => {
    expect(conversationTransport('telegram')).toBeUndefined();
  });

  // cm:guard the point of the registry, asserted rather than assumed: a SECOND adapter arrives as one more `registerConversationTransport` call, and nothing in the store changes to admit it (ISS-1001 criteria 34, 36).
  it('takes a second adapter with no change to the store', () => {
    registerConversationTransport(fakeTransport('web'));
    registerConversationTransport(fakeTransport('telegram'));
    expect(registeredConversationAdapters()).toEqual(['telegram', 'web']);
  });
});

describe('a screened message', () => {
  it('carries the exact text it was built around', () => {
    expect(codeAuthored('an ack').text).toBe('an ack');
  });

  it('admits model text on an ok verdict', () => {
    expect(screened('a reply', { ok: true, problems: [] })?.text).toBe('a reply');
  });

  // cm:guard a refused verdict yields NO value at all rather than one carrying the problems: the point is that a caller holding a `ScreenedMessage` is holding text a screen passed, so a shape that can represent "screened and refused" is the hole this closes (ISS-978's review found the structural version of it).
  it('yields nothing for a refused verdict, so refused text cannot be delivered', () => {
    expect(screened('a bad reply', { ok: false, problems: ['cites ISS-99'] })).toBeNull();
  });
});
