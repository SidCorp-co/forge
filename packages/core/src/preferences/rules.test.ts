// The seen-mark rule: a mark naming a release is held to the instance's own environment and the
// release it serves, each refused by its own code; a mark naming none, and every other key, never ask.
import { describe, expect, it, vi } from 'vitest';
import type { ServingRead } from './ports.js';
import { productStateValueRefusal } from './rules.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const AT = '2026-10-09T11:00:00Z';
const mark = (environment: string, version: string) => ({
  at: AT,
  release: { environment, version, at: AT },
});
const refusal = (value: unknown, serving: ServingRead) =>
  productStateValueRefusal('whats_new_seen_at', value, NOW, async () => serving);

describe("a What's new mark naming a release", () => {
  const serving = { environment: 'dev', version: '0.4.0-dev.9' };

  it('is kept for the release this instance serves, in its own environment', async () => {
    expect(await refusal(mark('dev', '0.4.0-dev.9'), serving)).toBeNull();
  });

  it('is refused for a version the instance does not serve, saying which it does', async () => {
    expect(await refusal(mark('dev', '0.4.0-dev.10'), serving)).toMatchObject({
      code: 'RELEASE_SEEN_NOT_SERVING',
      path: '/value/release/version',
      detail: 'this instance serves release 0.4.0-dev.9, not 0.4.0-dev.10',
    });
  });

  it('is refused for another environment', async () => {
    expect(await refusal(mark('beta', '0.4.0-dev.9'), serving)).toMatchObject({
      code: 'RELEASE_SEEN_NOT_SERVING',
      path: '/value/release/environment',
    });
  });

  it('is refused while the instance serves no release', async () => {
    expect(
      await refusal(mark('dev', '0.4.0-dev.9'), { environment: 'dev', version: null }),
    ).toMatchObject({
      code: 'RELEASE_SEEN_NOT_SERVING',
      detail: expect.stringContaining('serves no release'),
    });
  });

  it('is refused where the instance declares no environment', async () => {
    expect(
      await refusal(mark('dev', '0.4.0-dev.9'), { environment: null, version: null }),
    ).toMatchObject({ code: 'RELEASE_SEEN_ENVIRONMENT_UNKNOWN' });
  });

  it('is refused for a release shape the key does not hold, before the instance is asked', async () => {
    const ask = vi.fn(async () => serving);
    const r = await productStateValueRefusal(
      'whats_new_seen_at',
      { at: AT, release: { environment: 'dev', version: '', at: AT } },
      NOW,
      ask,
    );
    expect(r).toMatchObject({ code: 'PRODUCT_STATE_VALUE_INVALID' });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('a mark that names no release, and every other key', () => {
  it('never asks which release the instance serves', async () => {
    const ask = vi.fn(async () => ({ environment: null, version: null }));
    expect(await productStateValueRefusal('whats_new_seen_at', { at: AT }, NOW, ask)).toBeNull();
    expect(
      await productStateValueRefusal(
        'tour:integrations',
        { revision: 1, outcome: 'completed', at: AT },
        NOW,
        ask,
      ),
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});
