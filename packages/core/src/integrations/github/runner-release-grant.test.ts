import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const { ownerOfGrant } = await import('./runner-release-store.js');

const rowAt = (attempt: number) =>
  ({ id: 'rel-1', tag: 'runner-v0.13.3', attempt, step: 'resolve_repository' }) as never;

describe('the attempt an opener may act as', () => {
  it('owns the row when the reading still carries the attempt it was granted', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 2 }, rowAt(2))).toEqual({
      opened: rowAt(2),
      held: null,
    });
  });

  it('does NOT own a row the re-arm moved on between the two statements', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 2 }, rowAt(3))).toEqual({
      opened: null,
      held: rowAt(3),
    });
  });

  it('owns nothing at all when the row is gone by the read-back', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 1 }, null)).toBeNull();
  });

  it('compares the two as numbers, whatever the driver handed back', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 2 }, rowAt('2' as never))).toMatchObject({
      held: null,
    });
  });
});
