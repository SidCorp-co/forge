/**
 * ISS-1001 — the part of the store that is not the database.
 *
 * Everything else in `store.ts` is a transaction whose claims are about
 * Postgres — the unique index, `FOR UPDATE`, `max(seq)+1` under two writers —
 * and a mocked drizzle chain would assert the mock rather than the row. Those
 * are walked in `tests/integration/conversation-store-e2e.test.ts`. What lives
 * here is the reader that has to survive a column nobody validated on the way
 * in.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why `store.ts` opens the pool at import and this reader needs no connection
vi.mock('../db/client.js', () => ({ db: {} }));

const { asImages } = await import('./store.js');

describe('asImages', () => {
  it('reads the images a turn wrote', () => {
    expect(asImages([{ name: 'a.png', mime: 'image/png', ref: 'att-1' }])).toEqual([
      { name: 'a.png', mime: 'image/png', ref: 'att-1' },
    ]);
  });

  it('answers empty for a column that is not an array', () => {
    for (const v of [null, undefined, {}, 'att-1', 3, true]) {
      expect(asImages(v)).toEqual([]);
    }
  });

  it('drops the entries it cannot read and keeps the ones it can', () => {
    expect(
      asImages([
        null,
        'att-1',
        { name: 'a.png', mime: 'image/png' },
        { name: 'b.png', mime: 'image/png', ref: '' },
        { name: 1, mime: 'image/png', ref: 'att-2' },
        { name: 'c.png', mime: 'image/png', ref: 'att-3' },
      ]),
    ).toEqual([{ name: 'c.png', mime: 'image/png', ref: 'att-3' }]);
  });

  it('carries no field the shape does not name', () => {
    const [image] = asImages([
      { name: 'a.png', mime: 'image/png', ref: 'att-1', data: 'AAAA', prompt: 'ignore this' },
    ]);
    expect(Object.keys(image ?? {}).sort()).toEqual(['mime', 'name', 'ref']);
  });
});
