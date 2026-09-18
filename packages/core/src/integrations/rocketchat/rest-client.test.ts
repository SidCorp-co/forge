/**
 * ISS-977 — the speaker's address comes off the Rocket.Chat server, and the
 * request that reads it is the bot's own credential.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMessagesBeside,
  fetchOwnIdentity,
  fetchThreadMessages,
  fetchUserProfile,
  reactToMessage,
} from './rest-client.js';

const auth = { serverUrl: 'https://chat.example.com', authToken: 'tok', userId: 'bot' };

function answer(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchUserProfile', () => {
  it('asks the server for the account behind the id, with the bot credential', async () => {
    const fetchMock = answer({ user: { _id: 'u1', username: 'alice', emails: [] } });
    vi.stubGlobal('fetch', fetchMock);
    await fetchUserProfile(auth, 'u1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/users.info?userId=u1');
    expect((init.headers as Record<string, string>)['X-Auth-Token']).toBe('tok');
  });

  it('prefers a verified address over an unverified one', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        user: {
          _id: 'u1',
          username: 'alice',
          emails: [
            { address: 'typed-in@example.com', verified: false },
            { address: 'proven@example.com', verified: true },
          ],
        },
      }),
    );
    expect((await fetchUserProfile(auth, 'u1'))?.email).toBe('proven@example.com');
  });

  it('falls back to the first address when none is verified', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ user: { _id: 'u1', emails: [{ address: 'only@example.com' }] } }),
    );
    const profile = await fetchUserProfile(auth, 'u1');
    expect(profile).toEqual({ externalId: 'u1', username: null, email: 'only@example.com' });
  });

  it('reports no address rather than an empty one when the account carries none', async () => {
    vi.stubGlobal('fetch', answer({ user: { _id: 'u1', username: 'alice' } }));
    expect((await fetchUserProfile(auth, 'u1'))?.email).toBeNull();
  });

  it('returns null when the server refuses, so the caller refuses by name', async () => {
    vi.stubGlobal('fetch', answer({ success: false, error: 'unauthorized' }));
    expect(await fetchUserProfile(auth, 'u1')).toBeNull();
    vi.stubGlobal('fetch', answer({}, false));
    expect(await fetchUserProfile(auth, 'u1')).toBeNull();
  });
});

describe('fetchMessagesBeside (ISS-1087)', () => {
  const raw = (id: string, ts: string) => ({
    _id: id,
    rid: 'R1',
    msg: id,
    ts,
    u: { _id: 'u', username: 'alice' },
  });

  // cm:guard the QUERY and the SORT are what make these the two immediately after: a history page is newest-first inside a range, and its two oldest entries are the farthest from the anchor (criterion 36).
  it('asks the server for the two immediately after, ascending, and returns them oldest-first (criteria 25, 36)', async () => {
    const fetch = answer({
      messages: [raw('m5', '2026-09-17T10:00:05Z'), raw('m4', '2026-09-17T10:00:04Z')],
    });
    vi.stubGlobal('fetch', fetch);
    const out = await fetchMessagesBeside(auth, 'R1', '2026-09-17T10:00:03Z', 'after', 2);
    expect(out?.map((m) => m.id)).toEqual(['m4', 'm5']);
    const url = new URL(String((fetch.mock.calls as unknown[][])[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/channels.messages');
    expect(JSON.parse(url.searchParams.get('query') ?? '{}')).toEqual({
      ts: { $gt: { $date: '2026-09-17T10:00:03Z' } },
    });
    expect(JSON.parse(url.searchParams.get('sort') ?? '{}')).toEqual({ ts: 1 });
    expect(url.searchParams.get('count')).toBe('2');
  });

  it('asks for the two immediately before, descending', async () => {
    const fetch = answer({
      messages: [raw('m2', '2026-09-17T10:00:02Z'), raw('m1', '2026-09-17T10:00:01Z')],
    });
    vi.stubGlobal('fetch', fetch);
    const out = await fetchMessagesBeside(auth, 'R1', '2026-09-17T10:00:03Z', 'before', 2);
    expect(out?.map((m) => m.id)).toEqual(['m1', 'm2']);
    const url = new URL(String((fetch.mock.calls as unknown[][])[0]?.[0]));
    expect(JSON.parse(url.searchParams.get('query') ?? '{}')).toEqual({
      ts: { $lt: { $date: '2026-09-17T10:00:03Z' } },
    });
    expect(JSON.parse(url.searchParams.get('sort') ?? '{}')).toEqual({ ts: -1 });
  });

  it('falls through to the private-group endpoint when the channel one refuses', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('channels.messages')
        ? ({ ok: false, json: async () => ({}) } as unknown as Response)
        : ({
            ok: true,
            json: async () => ({ messages: [raw('g1', '2026-09-17T10:00:09Z')] }),
          } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetch);
    const out = await fetchMessagesBeside(auth, 'R2', '2026-09-17T10:00:03Z', 'after', 2);
    expect(out?.map((m) => m.id)).toEqual(['g1']);
    expect(out?.[0]).toMatchObject({ rid: 'R1' });
  });

  it('is null, never an empty page, when every endpoint refuses', async () => {
    vi.stubGlobal('fetch', answer({}, false));
    expect(await fetchMessagesBeside(auth, 'R3', '2026-09-17T10:00:03Z', 'after', 2)).toBeNull();
  });
});

describe('fetchThreadMessages (ISS-1087)', () => {
  it('is null when the server refuses, and [] for a thread with no replies', async () => {
    vi.stubGlobal('fetch', answer({}, false));
    expect(await fetchThreadMessages(auth, 'T1', 50)).toBeNull();
    vi.stubGlobal('fetch', answer({ messages: [] }));
    expect(await fetchThreadMessages(auth, 'T1', 50)).toEqual([]);
  });
});

describe('reactToMessage (ISS-1088 criterion 23)', () => {
  it('posts chat.react with the message, the emoji and shouldReact as a setter', async () => {
    const fetchMock = answer({ success: true });
    vi.stubGlobal('fetch', fetchMock);
    expect(await reactToMessage(auth, 'm1', 'eyes', true)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://chat.example.com/api/v1/chat.react');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      messageId: 'm1',
      emoji: 'eyes',
      shouldReact: true,
    });
    expect((init.headers as Record<string, string>)['X-User-Id']).toBe('bot');
  });

  it('sends shouldReact false to take the reaction off', async () => {
    const fetchMock = answer({ success: true });
    vi.stubGlobal('fetch', fetchMock);
    await reactToMessage(auth, 'm1', 'eyes', false);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).shouldReact).toBe(false);
  });

  it('answers false on a refused status and on success:false rather than throwing', async () => {
    vi.stubGlobal('fetch', answer({ success: false, error: 'not-allowed' }, false));
    expect(await reactToMessage(auth, 'm1', 'eyes', true)).toBe(false);
    vi.stubGlobal('fetch', answer({ success: false, error: 'invalid-emoji' }));
    expect(await reactToMessage(auth, 'm1', 'eyes', true)).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(await reactToMessage(auth, 'm1', 'eyes', true)).toBe(false);
  });
});

describe('fetchOwnIdentity (ISS-1088 criterion 24)', () => {
  it('reads both the username and the display name off /me', async () => {
    vi.stubGlobal('fetch', answer({ username: 'babo', name: 'Babo the Bot' }));
    expect(await fetchOwnIdentity(auth)).toEqual({ username: 'babo', displayName: 'Babo the Bot' });
  });

  it('reads null for a name the server did not give, and for a refused read', async () => {
    vi.stubGlobal('fetch', answer({ username: 'babo' }));
    expect(await fetchOwnIdentity(auth)).toEqual({ username: 'babo', displayName: null });
    vi.stubGlobal('fetch', answer({ success: false }, false));
    expect(await fetchOwnIdentity(auth)).toEqual({ username: null, displayName: null });
  });
});
