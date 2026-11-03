// The public health answer counts the pg-boss errors this process has logged since boot, so a
// recurring one shows on a poll of /health and not only in a log tail; never its message.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./service.js', () => ({
  readLiveness: async () => ({ ok: true, dbOk: true, queueOk: true, wsOk: true }),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { publicHealthRoutes } = await import('./routes.js');
const { onBossError } = await import('../queue/boss-errors.js');

const health = async () =>
  (await (await publicHealthRoutes.request('/health')).json()) as {
    queue: Record<string, unknown>;
  };

describe('/health', () => {
  it('counts pg-boss errors since boot and carries none of their text', async () => {
    const before = (await health()).queue.errorsSinceBoot as number;
    onBossError({ message: 'secret-looking detail', queue: 'outbox.q', worker: 'w' });
    const after = await health();
    expect(after.queue).toEqual({ ok: true, errorsSinceBoot: before + 1 });
    expect(JSON.stringify(after)).not.toContain('secret-looking');
  });
});

// ISS-753: the deploy probes append `_forge_cb` (integrations/deploy/runtime-probe.ts), and
// forge-dev's own runtime probe reads /version, so that key is taken and every other is refused
describe('the probe reads take the cache-buster and nothing else', () => {
  for (const path of ['/health', '/version']) {
    it(`${path} answers with _forge_cb and refuses another key by name`, async () => {
      expect((await publicHealthRoutes.request(`${path}?_forge_cb=1761777600000`)).status).toBe(
        200,
      );
      const refused = await publicHealthRoutes.request(`${path}?_forge_cb=1&verbose=1`);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe(
        'Unknown query parameter: `verbose`. This route takes: _forge_cb.',
      );
    });
  }
});

// ISS-930: once core's shutdown begins its drain, /health answers 503 draining so the proxy and the
// deploy probe stop reading it as ready; the liveness read is not reached
describe('/health while core drains', () => {
  it('answers 503 draining with Retry-After once shutdown starts', async () => {
    const { coreDrain } = await import('../lib/drain.js');
    expect((await publicHealthRoutes.request('/health')).status).toBe(200);
    coreDrain.begin();
    const res = await publicHealthRoutes.request('/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(await res.json()).toEqual({ ok: false, draining: true });
  });
});
