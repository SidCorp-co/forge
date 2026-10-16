// A box's polls of /api/devices/me/* log at debug when answered, so a 1000-line tail of an info
// log covers minutes of everything else rather than 30 seconds of polls; a refusal or a failure on
// them still logs at warn or error, and every other path is unchanged.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ getLogger: () => log }));

const { requestLogger } = await import('./logger.js');

function app(status: number) {
  const a = new Hono();
  a.use('*', requestLogger() as never);
  a.get('*', (c) => c.body(null, status as 200));
  return a;
}

const levelsOf = (msg: string) =>
  (['debug', 'info', 'warn', 'error'] as const).filter((l) =>
    log[l].mock.calls.some((call) => call[1] === msg),
  );

beforeEach(() => {
  for (const f of Object.values(log)) f.mockClear();
});

describe('the request log', () => {
  it("puts a box's answered poll at debug", async () => {
    await app(200).request('/api/devices/me/jobs');
    expect(levelsOf('request.start')).toEqual(['debug']);
    expect(levelsOf('request.end')).toEqual(['debug']);
  });

  it('keeps a refused or failed poll at warn or error', async () => {
    await app(403).request('/api/devices/me/jobs');
    expect(levelsOf('request.end')).toEqual(['warn']);
    await app(500).request('/api/devices/me/jobs');
    expect(levelsOf('request.end')).toEqual(['warn', 'error']);
  });

  it('logs every other path at info, a near-miss prefix included', async () => {
    await app(200).request('/api/devices/meter');
    await app(200).request('/api/projects/p/issues');
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(4);
  });
});
