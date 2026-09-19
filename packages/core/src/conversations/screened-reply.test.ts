/**
 * ISS-1087 — what counts as a declined turn: the sentinel at the front,
 * whatever the model added after it, and never the sentinel buried in prose.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { declinedTail, declinedTurn, NOTHING_TO_ADD } = await import('./screened-reply.js');

describe('declinedTurn', () => {
  it('is true for the bare sentinel, whatever its case and punctuation', () => {
    expect(declinedTurn(NOTHING_TO_ADD)).toBe(true);
    expect(declinedTurn('  (Nothing To Add).  ')).toBe(true);
  });

  it('is true for a reply that begins with the sentinel and continues (criterion 22)', () => {
    expect(declinedTurn('(nothing to add) — though you may want to check the build')).toBe(true);
  });

  it('is false for a reply that merely contains the sentinel later (criterion 23)', () => {
    expect(declinedTurn('The build is green. (nothing to add)')).toBe(false);
    expect(declinedTurn('nothing to add here really')).toBe(false);
  });
});

describe('declinedTail', () => {
  it('is what followed the sentinel, without the joining punctuation', () => {
    expect(declinedTail('(nothing to add) — though you may want to check the build')).toBe(
      'though you may want to check the build',
    );
    expect(declinedTail('(nothing to add).')).toBe('');
  });
});
