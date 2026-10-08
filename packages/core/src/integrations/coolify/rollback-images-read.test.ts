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
  it('names an unreachable Coolify, with what the transport said and its cause code', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const err = await refused(clientWith(fetchImpl));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('unreachable');
    expect(err.message).toContain('Could not reach Coolify');
    expect(err.message).toContain('fetch failed ECONNREFUSED');
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
    expect(err.message).toContain('Coolify timed out');
  });

  it('names a 200 whose body is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>login</html>', { status: 200 })) as typeof fetch;
    const err = await refused(clientWith(fetchImpl));
    expect(err).toBeInstanceOf(CoolifyReadFailedError);
    expect(err.kind).toBe('not-json');
    expect(err.message).toContain('something that is not JSON');
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
