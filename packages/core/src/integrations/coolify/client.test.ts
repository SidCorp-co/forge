import { describe, expect, it, vi } from 'vitest';
import { CoolifyApiError, CoolifyClient } from './client.js';

function makeFetch(handler: (req: { url: string; init: RequestInit }) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return handler({ url, init: init ?? {} });
  }) as unknown as typeof fetch;
}

describe('CoolifyClient', () => {
  it('sends bearer token and json content-type on deploy', async () => {
    const fetchImpl = makeFetch(({ url, init }) => {
      expect(url).toBe('https://coolify.example/api/v1/deploy');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ uuid: 'res-uuid', force: false });
      return new Response(
        JSON.stringify({ deployment_uuid: 'dep-1', message: 'queued' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok-abc',
      fetchImpl,
    });
    const res = await client.deploy({ resourceUuid: 'res-uuid' });
    expect(res.deployment_uuid).toBe('dep-1');
  });

  it('falls back to previousApiToken on 401', async () => {
    let attempt = 0;
    const fetchImpl = makeFetch(({ init }) => {
      attempt++;
      const token = (init.headers as Record<string, string>).Authorization;
      if (token === 'Bearer current-tok') {
        return new Response('unauthorized', { status: 401 });
      }
      expect(token).toBe('Bearer previous-tok');
      return new Response(JSON.stringify({ deployment_uuid: 'd-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'current-tok',
      previousApiToken: 'previous-tok',
      fetchImpl,
    });
    const res = await client.deploy({ resourceUuid: 'r' });
    expect(attempt).toBe(2);
    expect(res.deployment_uuid).toBe('d-2');
  });

  it('throws CoolifyApiError on non-2xx other than 401', async () => {
    const fetchImpl = makeFetch(() => new Response('boom', { status: 500 }));
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    await expect(client.deploy({ resourceUuid: 'r' })).rejects.toBeInstanceOf(CoolifyApiError);
  });

  it('hits /resources/:uuid on healthcheck', async () => {
    const fetchImpl = makeFetch(({ url, init }) => {
      expect(url).toBe('https://coolify.example/api/v1/resources/res-uuid');
      expect(init.method).toBe('GET');
      return new Response(JSON.stringify({ uuid: 'res-uuid', name: 'web' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    const res = await client.getResource('res-uuid');
    expect(res.name).toBe('web');
  });
});
