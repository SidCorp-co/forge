// An upload read sends the bot's credential only to the chat server's own origin, whatever the server
// redirects to (ISS-1010): fetch drops `Authorization` on a cross-origin hop but keeps `X-Auth-Token`,
// so a server that hands uploads on to object storage would hand that host the bot's token.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAttachment } from './attachment-fetch.js';

const AUTH = { serverUrl: 'https://chat.test', authToken: 'bot-token', userId: 'bot-id' };
const REF = 'https://chat.test/file-upload/f1/shot.png';

interface Seen {
  url: string;
  token: string | null;
}

/**
 * A server over `fetch` that answers `routes`. Under `redirect: 'follow'` it follows as the platform
 * does: up to 20 hops, dropping only `Authorization` across origins, so `X-Auth-Token` rides along.
 */
function serve(routes: Record<string, () => Response>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    let url = String(input);
    const headers = new Headers(init?.headers);
    for (let hop = 0; hop <= 20; hop += 1) {
      seen.push({ url, token: headers.get('x-auth-token') });
      const route = routes[url];
      const res = route ? route() : new Response('no', { status: 404 });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next || init?.redirect !== 'follow') return res;
      const to = new URL(next, url);
      if (to.origin !== new URL(url).origin) headers.delete('authorization');
      url = to.toString();
    }
    throw new TypeError('redirect count exceeded');
  });
  return seen;
}

const redirect = (to: string) => () =>
  new Response(null, { status: 302, headers: { location: to } });

afterEach(() => vi.unstubAllGlobals());

describe('fetchAttachment', () => {
  it('follows a redirect to storage without the bot credential, and reads the file there', async () => {
    const seen = serve({
      [REF]: redirect('https://storage.test/bucket/shot.png?sig=1'),
      'https://storage.test/bucket/shot.png?sig=1': () => new Response(new Uint8Array([1, 2, 3])),
    });
    const got = await fetchAttachment(AUTH, REF, 1000);
    expect(got).toEqual({ ok: true, bytes: Buffer.from([1, 2, 3]) });
    expect(seen).toEqual([
      { url: REF, token: 'bot-token' },
      { url: 'https://storage.test/bucket/shot.png?sig=1', token: null },
    ]);
  });

  it('keeps the credential on a redirect within the chat server', async () => {
    const seen = serve({
      [REF]: redirect('/ufs/files/f1/shot.png'),
      'https://chat.test/ufs/files/f1/shot.png': () => new Response(new Uint8Array([9])),
    });
    expect((await fetchAttachment(AUTH, REF, 1000)).ok).toBe(true);
    expect(seen.map((s) => s.token)).toEqual(['bot-token', 'bot-token']);
  });

  it('says the server did not hand it over after too many redirects, never loops', async () => {
    const seen = serve({ [REF]: redirect(REF) });
    expect(await fetchAttachment(AUTH, REF, 1000)).toEqual({ ok: false, why: 'unreachable' });
    expect(seen).toHaveLength(4);
  });
});
