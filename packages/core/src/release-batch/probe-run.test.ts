/**
 * One kept probe run against the served build (REQ-36 BC-12; ISS-470): a request is sent to the
 * production environment's origin or the service it names and judged against what it expects; a
 * command is never run here; a probe with no origin, no credential or no answer could not run; the
 * replayer's credential goes out on the request and never into what the run answers.
 *
 * @direct-test-of packages/core/src/release-batch/probe-run.ts
 * @direct-test-of packages/core/src/integrations/deploy/kept-probe-request.ts
 */

import { describe, expect, it } from 'vitest';
import { COMMAND_NOT_REPLAYED, originOf, type ProbeRunContext, runKeptProbe } from './probe-run.js';

const ORIGINS = {
  environment: 'live',
  url: 'https://app.example.test/',
  services: { api: 'https://api.example.test' },
  routes: { api: ['/api'] },
};

const SECRET = 'Bearer forge_pat_replay_only';

function context(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const ctx: ProbeRunContext = {
    origins: ORIGINS,
    credential: async (origin) =>
      origin === 'https://api.example.test'
        ? { ok: true, authorization: SECRET }
        : { ok: false, why: `no credential for ${origin}` },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, init: init ?? {} });
      return answer(url, init ?? {});
    }) as typeof fetch,
  };
  return { ctx, sent };
}

const request = (over: Record<string, unknown> = {}, expect: Record<string, unknown> = {}) => ({
  kind: 'request',
  request: { method: 'GET', path: '/things/1', as: 'anonymous', ...over },
  expect: { status: 200, bodyIncludes: ['"ok":true'], ...expect },
});

describe('a request probe is judged against what it expects', () => {
  it('holds when the status and every text match, sent to the environment url', async () => {
    const { ctx, sent } = context(() => new Response('{"ok":true,"n":1}', { status: 200 }));
    const run = await runKeptProbe(request(), ctx);
    expect(run).toEqual({
      outcome: 'held',
      detail: 'GET /things/1 answered 200 with every text it expects',
      url: 'https://app.example.test/things/1',
    });
    expect(sent.map((s) => s.url)).toEqual(['https://app.example.test/things/1']);
  });

  it('fails naming the status it answered against the one it expects', async () => {
    const { ctx } = context(() => new Response('boom', { status: 500 }));
    const run = await runKeptProbe(request(), ctx);
    expect(run.outcome).toBe('failed');
    expect(run.detail).toBe('GET /things/1 answered 500, and the probe expects 200');
  });

  it('fails naming each expected text the body lacks', async () => {
    const { ctx } = context(() => new Response('{"ok":false}', { status: 200 }));
    const run = await runKeptProbe(request({}, { bodyIncludes: ['"ok":true', '"n":1'] }), ctx);
    expect(run.outcome).toBe('failed');
    expect(run.detail).toBe(
      'GET /things/1 answered 200 without `"ok":true`, `"n":1`, which the probe expects',
    );
  });

  it('a status with no texts expected holds without reading the body', async () => {
    const { ctx } = context(() => new Response(null, { status: 204 }));
    const run = await runKeptProbe(
      request({ method: 'DELETE' }, { status: 204, bodyIncludes: [] }),
      ctx,
    );
    expect(run).toMatchObject({ outcome: 'held', detail: 'DELETE /things/1 answered 204' });
  });

  it('does not follow a redirect: a 302 is what the build answered', async () => {
    const { ctx, sent } = context(
      () => new Response(null, { status: 302, headers: { location: '/login' } }),
    );
    const run = await runKeptProbe(request(), ctx);
    expect(run.detail).toBe('GET /things/1 answered 302, and the probe expects 200');
    expect(sent[0]?.init.redirect).toBe('manual');
  });
});

describe('where a request goes, and with whose credential', () => {
  it('a named service is sent to that service, with the replayer credential when it asks', async () => {
    const { ctx, sent } = context(() => new Response('{"ok":true}', { status: 200 }));
    const run = await runKeptProbe(
      request({ path: '/api/things/1', service: 'api', as: 'replayer' }),
      ctx,
    );
    expect(run.outcome).toBe('held');
    expect(sent[0]?.url).toBe('https://api.example.test/api/things/1');
    expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe(SECRET);
    expect(JSON.stringify(run)).not.toContain('forge_pat');
  });

  it('an anonymous probe goes out with no credential', async () => {
    const { ctx, sent } = context(() => new Response('{"ok":true}', { status: 200 }));
    await runKeptProbe(request({ path: '/api/things/1', service: 'api' }), ctx);
    expect(new Headers(sent[0]?.init.headers).has('authorization')).toBe(false);
  });

  it('could not run where the replayer holds no credential for the origin, sending nothing', async () => {
    const { ctx, sent } = context(() => new Response('{"ok":true}', { status: 200 }));
    const run = await runKeptProbe(request({ as: 'replayer' }), ctx);
    expect(run).toMatchObject({
      outcome: 'could_not_run',
      detail: 'no credential for https://app.example.test',
    });
    expect(sent).toEqual([]);
  });

  it('could not run naming a service production does not declare', async () => {
    const { ctx, sent } = context(() => new Response('', { status: 200 }));
    const run = await runKeptProbe(request({ service: 'admin' }), ctx);
    expect(run.outcome).toBe('could_not_run');
    expect(run.detail).toBe(
      'production environment `live` declares no service `admin` (it declares api); name one of those, or leave `service` out to use its `url`',
    );
    expect(sent).toEqual([]);
  });

  it('an environment with no url gives a path with no service nowhere to go', () => {
    const parsed = request() as Parameters<typeof originOf>[0];
    expect(originOf(parsed, { ...ORIGINS, url: null })).toEqual({
      ok: false,
      why: 'production environment `live` declares no `url`, so a probe naming no service has no origin to be replayed against',
    });
  });

  it('could not run when the service does not answer', async () => {
    const { ctx } = context(() => {
      throw new TypeError('fetch failed');
    });
    const run = await runKeptProbe(request(), ctx);
    expect(run).toMatchObject({
      outcome: 'could_not_run',
      detail: 'GET https://app.example.test/things/1 was not answered: fetch failed',
    });
  });
});

describe('a kept probe the routing says another origin answers is not sent', () => {
  it('a path a service routes, kept with no service, could not run instead of failing', async () => {
    const { ctx, sent } = context(() => new Response('', { status: 404 }));
    const run = await runKeptProbe(request({ path: '/api/things/1' }), ctx);
    expect(run.outcome).toBe('could_not_run');
    expect(run.detail).toBe(
      '`/api/things/1` is answered by service `api` (it routes `/api`), not by production environment `live`\'s `url`; send `service: "api"`',
    );
    expect(sent).toEqual([]);
  });
});

describe('what is never run here', () => {
  it('a command probe is not replayed, and says why', async () => {
    const { ctx, sent } = context(() => new Response('', { status: 200 }));
    const run = await runKeptProbe(
      { kind: 'command', command: { argv: ['node', 'probe.mjs'] }, expect: { exitCode: 0 } },
      ctx,
    );
    expect(run).toEqual({ outcome: 'not_replayed', detail: COMMAND_NOT_REPLAYED, url: null });
    expect(sent).toEqual([]);
  });

  it('a kept probe that is no probe shape could not run, naming the path', async () => {
    const { ctx, sent } = context(() => new Response('', { status: 200 }));
    const run = await runKeptProbe(
      {
        kind: 'request',
        request: { method: 'GET', path: 'https://evil.test/x', as: 'anonymous' },
        expect: { status: 200 },
      },
      ctx,
    );
    expect(run.outcome).toBe('could_not_run');
    expect(run.detail).toContain('/request/path');
    expect(sent).toEqual([]);
  });
});
