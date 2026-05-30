import { describe, expect, it, vi } from 'vitest';
import { CoolifyApiError, CoolifyClient } from './client.js';

function makeFetch(handler: (req: { url: string; init: RequestInit }) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return handler({ url, init: init ?? {} });
  }) as unknown as typeof fetch;
}

describe('CoolifyClient', () => {
  it('deploys via GET /api/v1/deploy with uuid+force query params (no body)', async () => {
    const fetchImpl = makeFetch(({ url, init }) => {
      expect(url).toBe('https://coolify.example/api/v1/deploy?uuid=res-uuid&force=false');
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
      expect(init.body).toBeUndefined();
      // Coolify v4 returns a deployments[] array.
      return new Response(
        JSON.stringify({ deployments: [{ deployment_uuid: 'dep-1', message: 'queued' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok-abc',
      fetchImpl,
    });
    const res = await client.deploy({ resourceUuid: 'res-uuid' });
    expect(res.deployments?.[0]?.deployment_uuid).toBe('dep-1');
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
      return new Response(JSON.stringify({ deployments: [{ deployment_uuid: 'd-2' }] }), {
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
    expect(res.deployments?.[0]?.deployment_uuid).toBe('d-2');
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

  it('lists /api/v1/resources and resolves the uuid on healthcheck', async () => {
    const fetchImpl = makeFetch(({ url, init }) => {
      expect(url).toBe('https://coolify.example/api/v1/resources');
      expect(init.method).toBe('GET');
      // Coolify v4 /resources is list-only — returns an array.
      return new Response(
        JSON.stringify([
          { uuid: 'other-uuid', name: 'api', status: 'running' },
          { uuid: 'res-uuid', name: 'web', status: 'running' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    const res = await client.getResource('res-uuid');
    expect(res.name).toBe('web');
    expect(res.status).toBe('running');
  });

  it('getDeployment hits GET /api/v1/deployments/<uuid> (Bearer) and returns status + logs', async () => {
    const fetchImpl = makeFetch(({ url, init }) => {
      expect(url).toBe('https://coolify.example/api/v1/deployments/dep-9');
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      expect(init.body).toBeUndefined();
      return new Response(
        JSON.stringify({
          deployment_uuid: 'dep-9',
          status: 'failed',
          logs: JSON.stringify([
            { output: "Cannot find module '@codemirror/state'", type: 'stderr' },
          ]),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    const res = await client.getDeployment('dep-9');
    expect(res.status).toBe('failed');
    expect(typeof res.logs).toBe('string');
  });

  it('getDeployment url-encodes the deployment uuid', async () => {
    const fetchImpl = makeFetch(({ url }) => {
      expect(url).toBe('https://coolify.example/api/v1/deployments/a%2Fb');
      return new Response(JSON.stringify({ status: 'finished' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    const res = await client.getDeployment('a/b');
    expect(res.status).toBe('finished');
  });

  it('throws a clear not-found (not a bare 404) when the uuid is absent from the list', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(JSON.stringify([{ uuid: 'other-uuid', name: 'api' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new CoolifyClient({
      baseUrl: 'https://coolify.example',
      apiToken: 'tok',
      fetchImpl,
    });
    await expect(client.getResource('res-uuid')).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('not found'),
    });
  });
});
