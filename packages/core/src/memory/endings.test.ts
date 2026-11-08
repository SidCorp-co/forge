// REQ-89 BC-5 (ISS-1156): which endings core can see happen, and the warning a write gets for one it cannot.
// @direct-test-of packages/core/src/memory/endings.ts

import { describe, expect, it } from 'vitest';
import { endingObserved, unobservedEndingWarning } from './endings.js';

describe('an entry ending', () => {
  it('is seen for an issue key on a note, a path, a route, a backticked config key or rule slug', () => {
    expect(endingObserved('note', 'ISS-12 lands')).toBe(true);
    expect(endingObserved('knowledge', 'packages/core/src/memory/indexer.ts changes')).toBe(true);
    expect(endingObserved('knowledge', 'POST /api/memory/search answers duplicates')).toBe(true);
    expect(endingObserved('policy', 'when `memory.noteWindowDays` changes')).toBe(true);
    expect(endingObserved('note', 'the rule `pace-rule` is rewritten')).toBe(true);
  });

  it('is not seen for a plugin version, a person deciding, or an issue key on an entry the issue rule does not retire', () => {
    expect(endingObserved('note', 'forge-plugin 0.9.3 ships')).toBe(false);
    expect(endingObserved('note', 'the owner decides the pace')).toBe(false);
    expect(endingObserved('knowledge', 'ISS-12 lands')).toBe(false);
  });

  it('warns a write whose ending core cannot see, by name and path, and nothing else', () => {
    expect(unobservedEndingWarning('note', 'forge-plugin 0.9.3 ships')).toEqual([
      expect.objectContaining({ code: 'ENDING_UNOBSERVED', path: '/endsWhen' }),
    ]);
    expect(unobservedEndingWarning('note', 'ISS-12 lands')).toEqual([]);
    expect(unobservedEndingWarning('note', undefined)).toEqual([]);
    expect(unobservedEndingWarning('issue', 'forge-plugin 0.9.3 ships')).toEqual([]);
  });
});
