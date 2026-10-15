import { describe, expect, it, vi } from 'vitest';

vi.mock('./db/client.js', () => ({ db: {} }));

const { registerEagerSubscribers } = await import('./eager-subscribers.js');

describe('registerEagerSubscribers', () => {
  it('subscribes nothing to jobCompleted: the memory extraction only review, test and fix reached is gone (ISS-1229)', () => {
    const on = vi.fn((_event: string, _fn: unknown, _opts?: unknown) => () => undefined);
    registerEagerSubscribers({ on } as never);
    expect(on.mock.calls.length).toBeGreaterThan(0);
    expect(on.mock.calls.map(([event]) => event)).not.toContain('jobCompleted');
  });
});
