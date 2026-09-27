// The two pure rules the verify window's termination rests on: what one reading
// has to show, and what a batch can tell about its own lateness when it opens.
// Apart from `verify.test.ts` because neither needs a probe, a clock or a
// deadline — nothing here stubs `fetch` at all (ISS-1199).

import { describe, expect, it } from 'vitest';
import { liveCarriesRoster, readingSatisfies } from './verify.js';

const NEW = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const OLD = 'a12b34c5d6e7f8091a2b3c4d5e6f708192a3b4c5';
const SAME = 'c0ffee1234567890abcdef1234567890abcdef12';
const ELSEWHERE = 'dead0beef1234567890abcdef1234567890abcde';

describe('readingSatisfies', () => {
  it('takes the claim as the whole proof, whatever was serving before', () => {
    expect(readingSatisfies(NEW, OLD, NEW)).toBe(true);
    expect(readingSatisfies(SAME, SAME, SAME)).toBe(true);
    expect(readingSatisfies(ELSEWHERE, OLD, NEW)).toBe(false);
  });

  // What makes the window terminate: the claim is the one reading that could
  // satisfy a claimed gate, and it always does.
  it('is satisfied by the claim itself, which is why a claimed gate is never unsatisfiable', () => {
    for (const before of [null, OLD, NEW, SAME]) {
      expect(readingSatisfies(NEW, before, NEW)).toBe(true);
    }
  });

  it('asks the build to have moved only where the release claims no commit', () => {
    expect(readingSatisfies(NEW, OLD, null)).toBe(true);
    expect(readingSatisfies(OLD, OLD, null)).toBe(false);
    expect(readingSatisfies(null, OLD, null)).toBe(false);
  });

  it('is never satisfied by a claimless reading when nothing was recorded serving before', () => {
    for (const live of [NEW, OLD, SAME]) expect(readingSatisfies(live, null, null)).toBe(false);
  });
});

describe('liveCarriesRoster', () => {
  it('answers true where any one roster merge is what live reports', () => {
    expect(liveCarriesRoster(SAME, [OLD, SAME])).toBe(true);
    expect(liveCarriesRoster(SAME, [OLD, NEW])).toBe(false);
  });

  it('passes over a roster issue carrying no merge commit', () => {
    expect(liveCarriesRoster(SAME, [null, SAME])).toBe(true);
    expect(liveCarriesRoster(SAME, [null, null])).toBe(false);
    expect(liveCarriesRoster(SAME, [])).toBe(false);
  });

  it('answers false where nothing was serving to compare against', () => {
    expect(liveCarriesRoster(null, [SAME])).toBe(false);
  });

  it('reads a whole roster sha against the abbreviation a deployment reports', () => {
    expect(liveCarriesRoster(SAME.slice(0, 8), [SAME])).toBe(true);
    expect(liveCarriesRoster(SAME, [SAME.slice(0, 8)])).toBe(false);
  });
});
