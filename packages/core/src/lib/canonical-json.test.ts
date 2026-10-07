import { describe, expect, it } from 'vitest';
import { autoflowDraftVersion } from '../integrations/autoflow/draft.js';
import { fingerprintOf } from '../suggestions/rules.js';
import { byCodeUnits, canonicalJson, stableStringify } from './canonical-json.js';

const sample = {
  b: [1, { z: 1, a: undefined, y: null }, undefined],
  a: '\u00e9',
  ab: { d: 1, c: [] },
  B: true,
};

describe('canonical-json', () => {
  it('equal values in another key order stringify equal, and undefined fields are dropped', () => {
    expect(stableStringify({ a: 1, b: { d: 1, c: 2 } })).toBe(
      stableStringify({ b: { c: 2, d: 1 }, a: 1 }),
    );
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(stableStringify([undefined])).toBe('[null]');
  });

  it('orders keys by code unit, upper case before lower case', () => {
    expect(stableStringify({ b: 1, B: 1 })).toBe('{"B":1,"b":1}');
    expect(byCodeUnits('B', 'a')).toBe(-1);
    expect(byCodeUnits('a', 'a')).toBe(0);
  });

  it('the contract artifact form is indented with a trailing newline', () => {
    expect(canonicalJson({ b: 1, a: [] })).toBe('{\n  "a": [],\n  "b": 1\n}\n');
  });

  // Stored hashes are read back against: they must not move when the canonicaliser is shared.
  it('pins the stored fingerprint and draft version', () => {
    expect(fingerprintOf('x' as never, sample)).toBe('0e159dfa1abd2eb8e5f3455d257cf112');
    expect(autoflowDraftVersion(sample)).toBe(
      'c49010ba94a22515640d6948e5020e4cb52fdef4d27d5d79470fabf93e6bd84e',
    );
    expect(autoflowDraftVersion(undefined)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(autoflowDraftVersion(null)).toBe(
      '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    );
    expect(autoflowDraftVersion({ nodes: [{ id: 'n1', cfg: { k: 1, a: 2 } }], name: 'w' })).toBe(
      'c4f12c8090a45960be109c3aa733dbdb4600da98791cd108ff58a6b0e31ad7f2',
    );
  });
});
