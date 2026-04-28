import { describe, expect, it } from 'vitest';
import { encodeVectorLiteral } from './pgvector.js';

describe('encodeVectorLiteral', () => {
  it('encodes a basic vector', () => {
    expect(encodeVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('encodes empty vector', () => {
    expect(encodeVectorLiteral([])).toBe('[]');
  });

  it('encodes negative + zero', () => {
    expect(encodeVectorLiteral([-0.5, 0, 0.5])).toBe('[-0.5,0,0.5]');
  });

  it('throws on NaN', () => {
    expect(() => encodeVectorLiteral([0.1, Number.NaN, 0.3])).toThrow(/non-finite/);
  });

  it('throws on Infinity', () => {
    expect(() => encodeVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
  });
});
