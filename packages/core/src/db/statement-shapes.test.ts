import { describe, expect, it } from 'vitest';
import { fingerprintOf, repeatedShapes, shapeOf, shapeTextOf } from './statement-shapes.js';

describe('statement shapes', () => {
  it('reads one statement sent with lists of any length, or other literals, as one shape', () => {
    const two = 'select "id" from "issues" where "issues"."id" in ($1, $2) and n > 3';
    const five = 'select "id" from "issues" where "issues"."id" in ($1, $2, $3, $4, $5) and n > 40';
    expect(shapeOf(two)).toBe('select "id" from "issues" where "issues"."id" in (…) and n > ?');
    expect(fingerprintOf(two)).toBe(fingerprintOf(five));
    expect(fingerprintOf(two)).toMatch(/^[0-9a-f]{8}$/);
    expect(shapeTextOf(fingerprintOf(five))).toBe(shapeOf(two));
  });

  it('keeps no literal a statement carries, and no digit inside a name', () => {
    const shape = shapeOf(
      "SELECT t1.iss_seq FROM t1 WHERE t1.key = 'ISS-''42''' AND t1.at > 1.5 AND t1.id = ANY(ARRAY['a', 'b'])",
    );
    expect(shape).toBe(
      'SELECT t1.iss_seq FROM t1 WHERE t1.key = ? AND t1.at > ? AND t1.id = ANY(ARRAY[…])',
    );
    expect(shapeOf('INSERT INTO x VALUES ($1, $2), ($3, $4), ($5, $6)')).toBe(
      'INSERT INTO x VALUES (…)',
    );
  });

  it('names the most repeated shapes, counting texts of one shape together, and none sent once', () => {
    const sent = new Map([
      ['select a from t where id in ($1)', 4],
      ['select a from t where id in ($1, $2)', 3],
      ['select b from u', 2],
      ['select c from v', 1],
    ]);
    expect(repeatedShapes(sent, 3)).toEqual([
      { fingerprint: fingerprintOf('select a from t where id in ($1)'), count: 7 },
      { fingerprint: fingerprintOf('select b from u'), count: 2 },
    ]);
    expect(repeatedShapes(sent, 1)).toHaveLength(1);
  });
});
