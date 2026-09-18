import { screenAtDoor } from '../messaging/screen.js';

/** A real passing verdict: since ISS-978 nothing else can produce one. */
const passingVerdict = () => screenAtDoor('chat-sync', ['a reply']);

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
    expect(screened('a reply', 'chat-sync', passingVerdict())?.text).toBe('a reply');
  });

  // cm:guard the proof names the string the screen passed, and nothing else can mint one — the check
  // that ISS-978 F5 found missing everywhere this value travelled.
  it('carries a proof minted for that exact string', () => {
    const message = screened('a reply', 'chat-sync', passingVerdict());
    expect(message?.proof).toMatchObject({ text: 'a reply', door: 'chat-sync' });
  });

  // cm:guard TWO assertions on one line, and they fail for different reasons. The `@ts-expect-error` is
  // the compile-time half: un-brand `MessageVerdict`'s `ok` arm and the literal compiles, the directive
  // goes unused, and `tsc` fails with TS2578. The `toBeNull` is the runtime half, and it only became
  // possible once a verdict carried the segments it was passed over — a forged one has registered
  // nothing, so it can mint no proof. Before that this line could only be a comment.
  it('refuses a forged verdict, which also does not compile', () => {
    expect(
      // @ts-expect-error ISS-978 F5: `{ ok: true }` is not a MessageVerdict — the whole
      // point of branding the arm is that a caller cannot declare its own text screened.
      screened('a reply', 'chat-sync', { ok: true }),
    ).toBeNull();
  });

  // cm:guard the finding the whole-set review raised against the first version of this fix: a GENUINE
  // verdict for one string could mint a proof for another, with no cast anywhere, which moved the
  // ISS-978 F5 pairing rather than closing it. A verdict now says what it was passed over and `proven`
  // compares it, so screening A and sending B is refused at the mint.
  it('refuses a genuine verdict raised over different text', () => {
    const verdictForA = screenAtDoor('chat-sync', ['the answer that was screened']);
    expect(verdictForA.ok).toBe(true);
    expect(screened('something else entirely', 'chat-sync', verdictForA)).toBeNull();
  });

  // cm:guard a refused verdict yields NO value at all rather than one carrying the problems: the point is that a caller holding a `ScreenedMessage` is holding text a screen passed, so a shape that can represent "screened and refused" is the hole this closes (ISS-978's review found the structural version of it).
  it('yields nothing for a refused verdict, so refused text cannot be delivered', () => {
    expect(
      screened('a bad reply', 'chat-sync', {
        ok: false,
        refusals: [
          {
            rule: 'no-unverified-claim',
            why: 'cites ISS-99',
            quote: null,
            shape: 's',
            example: 'e',
          },
        ],
      }),
    ).toBeNull();
  });
});
