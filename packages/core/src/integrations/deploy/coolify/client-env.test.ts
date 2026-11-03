// ISS-827 — the Coolify client's env calls: a value goes to Coolify and nothing of one comes back.
// The list drops values where it parses, and a refused env call drops Coolify's answer body.
import { describe, expect, it } from 'vitest';
import { CoolifyApiError, CoolifyClient, coolifyAbilityForRoute } from './client.js';

const SECRET = 'planted-secret-value-7f3a';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}

function clientAnswering(status: number, answer: unknown) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({
      method: String(init.method),
      url: String(url),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return {
    client: new CoolifyClient({
      baseUrl: 'http://coolify.test',
      apiToken: 'tok-12345678',
      fetchImpl,
    }),
    seen,
  };
}

describe('listApplicationEnvKeys', () => {
  it('hands on each key and where it applies, and no value', async () => {
    const { client, seen } = clientAnswering(200, [
      { uuid: 'e1', key: 'API_KEY', value: SECRET, real_value: SECRET, is_preview: false },
      { uuid: 'e2', key: 'API_KEY', value: SECRET, is_preview: true },
      { key: 'NO_UUID', value: SECRET },
    ]);
    const keys = await client.listApplicationEnvKeys('app-1');
    expect(keys).toEqual([
      { uuid: 'e1', key: 'API_KEY', isPreview: false },
      { uuid: 'e2', key: 'API_KEY', isPreview: true },
    ]);
    expect(JSON.stringify(keys)).not.toContain(SECRET);
    expect(seen).toEqual([
      { method: 'GET', url: 'http://coolify.test/api/v1/applications/app-1/envs', body: undefined },
    ]);
  });
});

describe('the env writes', () => {
  it('creates with POST and updates with PATCH, a production variable each time', async () => {
    const { client, seen } = clientAnswering(201, { uuid: 'e1' });
    await client.createApplicationEnv('app-1', { key: 'API_KEY', value: SECRET });
    await client.updateApplicationEnv('app-1', { key: 'API_KEY', value: SECRET });
    await client.deleteApplicationEnv('app-1', 'e1');
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
      [
        'POST',
        'http://coolify.test/api/v1/applications/app-1/envs',
        { key: 'API_KEY', value: SECRET, is_preview: false },
      ],
      [
        'PATCH',
        'http://coolify.test/api/v1/applications/app-1/envs',
        { key: 'API_KEY', value: SECRET, is_preview: false },
      ],
      ['DELETE', 'http://coolify.test/api/v1/applications/app-1/envs/e1', undefined],
    ]);
  });

  it('drops the answer body of a refused write, which may quote the value it was sent', async () => {
    const { client } = clientAnswering(422, { message: `value ${SECRET} is invalid` });
    const err = await client
      .updateApplicationEnv('app-1', { key: 'API_KEY', value: SECRET })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoolifyApiError);
    const e = err as CoolifyApiError;
    expect([e.status, e.route, e.body]).toEqual([422, 'PATCH /api/v1/applications/app-1/envs', '']);
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain(SECRET);
  });

  it('names the ability each env route wants, so a 403 says which to widen', () => {
    expect(coolifyAbilityForRoute('GET /api/v1/applications/a/envs')).toBe('read');
    for (const m of ['POST', 'PATCH']) {
      expect(coolifyAbilityForRoute(`${m} /api/v1/applications/a/envs`)).toBe('write');
    }
    expect(coolifyAbilityForRoute('DELETE /api/v1/applications/a/envs/e1')).toBe('write');
  });
});
