/** ISS-1194 — a rollback-images read that gets no HTTP answer is named, whichever way the transport failed. */

import { describe, expect, it } from 'vitest';
import { CoolifyApiError, CoolifyClient } from './client.js';
import { CoolifyReadFailedError, readRollbackImagesNamingFailure } from './rollback-images-read.js';

const clientWith = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  new CoolifyClient({
    baseUrl: 'https://coolify.example',
    apiToken: 'tok',
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const refused = (c: CoolifyClient) => readRollbackImagesNamingFailure(c, 'app-1').catch((e) => e);

describe('readRollbackImagesNamingFailure', () => {
  // ISS-1421 r18 — the transport's own "fetch failed ENOTFOUND" was shown to a person, and the
  // server it could not reach was called Coolify.
  it('names the server it could not reach and why, in its own words', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const err = await refused(clientWith(fetchImpl));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toBe(
      'Forge could not reach the server at coolify.example for GET /api/v1/applications/app-1/rollback-images, because nothing accepted the connection at its address. Forge has no rollback image list to read.',
    );
    expect(err.message).not.toMatch(/fetch failed|ECONNREFUSED/);
  });

  it('names a Coolify that did not answer in time', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const err = await refused(clientWith(fetchImpl, 5));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toContain('Forge got no answer to');
    expect(err.message).toContain('in time from the server at coolify.example.');
    expect(err.message).toContain('GET /api/v1/applications/app-1/rollback-images');
  });

  it('names a 200 whose body is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>login</html>', { status: 200 })) as typeof fetch;
    const err = await refused(clientWith(fetchImpl));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('not-json');
    expect(err.message).toContain(
      'The server at coolify.example answered GET /api/v1/applications/app-1/rollback-images with something that is not JSON, so it may not be Coolify.',
    );
    expect(err.message).not.toContain('Unexpected token');
    expect(err.message).toContain('GET /api/v1/applications/app-1/rollback-images');
  });

  it('leaves a Coolify HTTP refusal as the CoolifyApiError it is', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    expect(await refused(clientWith(fetchImpl))).toBeInstanceOf(CoolifyApiError);
  });

  it('returns the list when Coolify answers one', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ current: 'a', images: [{ tag: 'a' }] }), {
        status: 200,
      })) as typeof fetch;
    const res = await readRollbackImagesNamingFailure(clientWith(fetchImpl), 'app-1');
    expect(res.current).toBe('a');
  });
});
