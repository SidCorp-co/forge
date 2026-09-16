import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConversationTransport,
  clearConversationTransports,
  codeAuthored,
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

  it('yields nothing for a refused verdict, so refused text cannot be delivered', () => {
    expect(screened('a bad reply', { ok: false, problems: ['cites ISS-99'] })).toBeNull();
  });
});
