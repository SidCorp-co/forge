/**
 * What an opener owns, between the statement that granted it an attempt and the
 * statement that reads the row back.
 *
 * The window is one this table's own re-arm opens: a release settled by the
 * deadline is re-armed in place by the next start, and the row a paused opener
 * reads back afterwards is a different attempt wearing the same id. Every fence
 * on `runner_releases` compares against the attempt its caller is holding, so a
 * caller that adopts the number off that later reading passes all of them —
 * against somebody else's live release.
 */

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

  // cm:guard this is the whole reason the grant travels back from the INSERT. Read the attempt off the row instead and this case returns `opened`, the caller acts as the owner of attempt 3, and its advance, its settle and — at the end of preflight — its CREATE all land on a release another start is running.
  it('does NOT own a row the re-arm moved on between the two statements', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 2 }, rowAt(3))).toEqual({
      opened: null,
      held: rowAt(3),
    });
  });

  it('owns nothing at all when the row is gone by the read-back', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 1 }, null)).toBeNull();
  });

  // cm:guard postgres-js hands an integer column back as a string on some drivers, and `'2' !== 2` would refuse every grant this function was given — a release that opens, reports held, and never runs.
  it('compares the two as numbers, whatever the driver handed back', () => {
    expect(ownerOfGrant({ id: 'rel-1', attempt: 2 }, rowAt('2' as never))).toMatchObject({
      held: null,
    });
  });
});
