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
      'Forge could not reach the server at coolify.example to ask for the rollback images of application app-1, because nothing accepted the connection at its address. Forge has no rollback image list to read.',
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
    expect(err.message).toBe(
      'Forge asked the server at coolify.example for the rollback images of application app-1 and got no answer in time. Forge has no rollback image list to read.',
    );
  });

  it('names a 200 whose body is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>login</html>', { status: 200 })) as typeof fetch;
    const err = await refused(clientWith(fetchImpl));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('not-json');
    expect(err.message).toContain(
      'Forge asked the server at coolify.example for the rollback images of application app-1, and it answered with something that is not JSON, so it may not be Coolify.',
    );
    expect(err.message).not.toContain('Unexpected token');
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

// ISS-1421 r28 — judge-114 read "for GET /api/v1/applications" in the deploy-target picker.
describe('a read failure says what was asked for in words', () => {
  it('names no HTTP route for the application list or the rollback images', async () => {
    const { listApplicationsNamingFailure } = await import('./rollback-images-read.js');
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as typeof fetch;
    const apps = await listApplicationsNamingFailure(clientWith(fetchImpl)).catch((e) => e);
    expect(apps.message).toBe(
      'Forge could not reach the server at coolify.example to ask for its list of applications, because its host name does not resolve. Forge has no application list to read.',
    );
    const images = await refused(clientWith(fetchImpl));
    for (const said of [apps.message, images.message]) expect(said).not.toMatch(/GET |\/api\//);
  });
});
