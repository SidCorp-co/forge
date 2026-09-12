/**
 * ISS-977 — the speaker's address comes off the Rocket.Chat server, and the
 * request that reads it is the bot's own credential.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUserProfile } from './rest-client.js';

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
