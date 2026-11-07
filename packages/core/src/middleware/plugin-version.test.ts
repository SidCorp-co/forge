// ISS-1104: core reads the plugin version a client names and warns, rather than refuses, where a
// route has narrowed a shape that plugin version still sends. The gates that call
// `admitPluginVersion` are the integration suite's (`plugin-version-e2e.test.ts`); here a stand-in
// gate admits the caller a test header names, so the rule itself is read without a database.

import {
  comparePluginVersions,
  FORGE_WARNING_HEADER,
  PLUGIN_VERSION_HEADER,
  parsePluginVersion,
} from '@forge/contracts/plugin-version';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from './request-id.js';

const written: Array<{ set: unknown; table: unknown }> = [];

vi.mock('../db/client.js', () => ({
  db: {
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: async () => {
          written.push({ table, set });
        },
      }),
    }),
  },
}));

const { logger } = await import('../lib/logger.js');
const warn = vi.spyOn(logger, 'warn');
const { errorHandler } = await import('./error.js');
const { admitPluginVersion, narrowedFor, pluginVersionWritesSettled } = await import(
  './plugin-version.js'
);

const NARROWING = {
  since: '3.36.681',
  code: 'VERDICT_SHAPE_RETIRED',
  detail: 'send verdicts as a list under `verdicts`',
  path: '/verdict',
};

let callerSeq = 0;

/**
 * `x-test-caller: device|token|session`, read as a gate reads its credential: a header token is a
 * plugin client, a session is not. Each test's caller is its own row, so once-per-caller logging
 * is read per test.
 */
function app() {
  const a = new Hono<{ Variables: RequestIdVars }>();
  const callerId = `row-${++callerSeq}`;
  a.use('*', async (c, next) => {
    const as = c.req.header('x-test-caller');
    admitPluginVersion(c, as === 'device' || as === 'token' ? { kind: as, id: callerId } : null);
    await next();
  });
  // the route as it was: the narrowed shape refused to every caller
  a.post('/legacy', async (c) => {
    const body = (await c.req.json()) as { verdict?: unknown };
    if (body.verdict !== undefined) {
      const { RefusalError } = await import('../lib/refusal.js');
      throw new RefusalError([{ ...NARROWING }], NARROWING.code);
    }
    return c.json({ ok: true });
  });
  // the route adopting the helper
  a.post('/narrowed', async (c) => {
    const body = (await c.req.json()) as { verdict?: unknown };
    if (body.verdict !== undefined) narrowedFor(c, NARROWING);
    return c.json({ ok: true });
  });
  a.onError(errorHandler);
  return a;
}

function send(
  a: Hono<{ Variables: RequestIdVars }>,
  route: string,
  headers: Record<string, string>,
) {
  return a.request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ verdict: 'pass' }),
  });
}

beforeEach(() => {
  written.length = 0;
  warn.mockClear();
});

describe('a narrowed shape sent by a plugin older than the narrowing', () => {
  it('was refused on the route as it stood, the defect the helper ends', async () => {
    const r = await send(app(), '/legacy', {
      'x-test-caller': 'device',
      [PLUGIN_VERSION_HEADER]: '3.36.600',
    });
    expect(r.status).toBe(422);
  });

  it('passes with the helper, carrying the warning a client can read', async () => {
    const r = await send(app(), '/narrowed', {
      'x-test-caller': 'device',
      [PLUGIN_VERSION_HEADER]: '3.36.600',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get(FORGE_WARNING_HEADER)).toBe(
      'VERDICT_SHAPE_RETIRED: send verdicts as a list under `verdicts`',
    );
  });

  it('passes for a plugin client naming no version, the releases that never sent the header', async () => {
    const r = await send(app(), '/narrowed', { 'x-test-caller': 'token' });
    expect(r.status).toBe(200);
    expect(r.headers.get(FORGE_WARNING_HEADER)).toMatch(/^VERDICT_SHAPE_RETIRED: /);
  });

  it('passes for a prerelease of the narrowing version, which sorts below it', async () => {
    const r = await send(app(), '/narrowed', {
      'x-test-caller': 'token',
      [PLUGIN_VERSION_HEADER]: '3.36.681-rc.2',
    });
    expect(r.status).toBe(200);
  });

  it('logs the warning once per caller per code, however often it is met', async () => {
    const a = app();
    for (let i = 0; i < 3; i++) {
      const r = await send(a, '/narrowed', {
        'x-test-caller': 'device',
        [PLUGIN_VERSION_HEADER]: '3.36.1',
      });
      expect(r.status).toBe(200);
    }
    const logged = warn.mock.calls.filter(
      ([fields]) => (fields as { code?: string }).code === NARROWING.code,
    );
    expect(logged).toHaveLength(1);
  });
});

describe('a narrowed shape held to callers who can meet it', () => {
  it.each([
    ['at the narrowing version', '3.36.681'],
    ['above it', '3.37.0'],
    ['a major above it', '4.0.0'],
  ])('refuses a plugin %s as the route did before', async (_, version) => {
    const r = await send(app(), '/narrowed', {
      'x-test-caller': 'device',
      [PLUGIN_VERSION_HEADER]: version,
    });
    expect(r.status).toBe(422);
    expect(r.headers.get(FORGE_WARNING_HEADER)).toBeNull();
    const body = (await r.json()) as { code: string; detail: string };
    expect(body.code).toBe('VERDICT_SHAPE_RETIRED');
    expect(body.detail).toBe(NARROWING.detail);
  });

  it("refuses a person's session, which is no plugin client, whatever version it names", async () => {
    for (const headers of [
      { 'x-test-caller': 'session' },
      { 'x-test-caller': 'session', [PLUGIN_VERSION_HEADER]: '1.0.0' },
    ]) {
      const r = await send(app(), '/narrowed', headers);
      expect(r.status).toBe(422);
    }
  });
});

describe('the version header itself', () => {
  it.each([
    ['a bare word', 'latest'],
    ['two parts', '3.36'],
    ['a leading zero', '3.036.1'],
    ['a v prefix', 'v3.36.681'],
    ['an empty value', ''],
    ['a value past the length cap', `3.36.681-${'a'.repeat(80)}`],
  ])('refuses %s by name, never ignoring it', async (_, value) => {
    for (const caller of ['device', 'session']) {
      const r = await send(app(), '/narrowed', {
        'x-test-caller': caller,
        [PLUGIN_VERSION_HEADER]: value,
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { code: string; message: string };
      expect(body.code).toBe('PLUGIN_VERSION_MALFORMED');
      expect(body.message).toContain('MAJOR.MINOR.PATCH');
    }
  });

  it('records the version on the row the request authenticated as, and not again unchanged', async () => {
    const a = app();
    for (let i = 0; i < 2; i++) {
      await send(a, '/narrowed', {
        'x-test-caller': 'device',
        [PLUGIN_VERSION_HEADER]: '3.36.700',
      });
    }
    await pluginVersionWritesSettled();
    expect(written).toHaveLength(1);
    expect(written[0]?.set).toMatchObject({ pluginVersion: '3.36.700' });

    await send(a, '/narrowed', { 'x-test-caller': 'device', [PLUGIN_VERSION_HEADER]: '3.36.701' });
    await pluginVersionWritesSettled();
    expect(written).toHaveLength(2);
    expect(written[1]?.set).toMatchObject({ pluginVersion: '3.36.701' });
  });

  it("records nothing for a person's session", async () => {
    await send(app(), '/narrowed', {
      'x-test-caller': 'session',
      [PLUGIN_VERSION_HEADER]: '3.36.700',
    });
    await pluginVersionWritesSettled();
    expect(written).toHaveLength(0);
  });
});

describe('plugin version order', () => {
  const v = (s: string) => {
    const p = parsePluginVersion(s);
    if (!p) throw new Error(`unparsed ${s}`);
    return p;
  };
  it('orders field by field, never as text', () => {
    expect(comparePluginVersions(v('3.36.681'), v('3.36.99'))).toBeGreaterThan(0);
    expect(comparePluginVersions(v('3.100.0'), v('3.36.681'))).toBeGreaterThan(0);
    expect(comparePluginVersions(v('3.36.681'), v('3.36.681+build.7'))).toBe(0);
  });
  it('sorts a prerelease below its release, numerics below words', () => {
    expect(comparePluginVersions(v('3.37.0-rc.1'), v('3.37.0'))).toBeLessThan(0);
    expect(comparePluginVersions(v('3.37.0-rc.2'), v('3.37.0-rc.10'))).toBeLessThan(0);
    expect(comparePluginVersions(v('3.37.0-1'), v('3.37.0-alpha'))).toBeLessThan(0);
    expect(comparePluginVersions(v('3.37.0-rc'), v('3.37.0-rc.1'))).toBeLessThan(0);
  });
});
