import { describe, expect, it } from 'vitest';
import { readUnresolvableEdges } from './archmap-stats.mjs';

/** A spawnSync result, defaulting to the shape a clean run produces. */
function spawn(over = {}) {
  return { status: 0, signal: null, error: undefined, stdout: '', stderr: '', ...over };
}

const REAL_STATS =
  'archmap check\n  mapped 96.9%  (source 1509 · test 1129 · unmapped 83 · generated 1)\n' +
  '  31 unresolvable of 9372 possible edges (0.3%) — not counted as violations\n';

describe('the stats line is read whatever the exit status', () => {
  it('reads the 0.1.3+ phrasing archmap prints today', () => {
    expect(readUnresolvableEdges(spawn({ stdout: REAL_STATS }))).toEqual({ measured: 31 });
  });

  it('reads the <= 0.1.2 phrasing, which the regex still has to match', () => {
    expect(readUnresolvableEdges(spawn({ stdout: '  7 unresolvable edges\n' }))).toEqual({
      measured: 7,
    });
  });

  // cm:guard the parse runs BEFORE the exit status is consulted, and this is the case that forces
  // it: `archmap check` is a checker and exits non-zero on violations while still printing its
  // stats. Deciding on the status first would call every real violation "could not run", which is a
  // gate going quiet — strictly worse than the false red this whole module exists to stop.
  it('still reads the count when archmap exited non-zero because it found violations', () => {
    expect(
      readUnresolvableEdges(spawn({ status: 1, stdout: REAL_STATS, stderr: '3 violations' })),
    ).toEqual({ measured: 31 });
  });
});

describe('a tool that ran and printed something unreadable stays LOUD', () => {
  // This is the case R7 was written for and it must keep failing: archmap renaming its stats line
  // while a repo's graph quietly stops resolving looks identical to a clean repo downstream.
  it('reports measured:null — not blocked — when archmap exits 0 with different wording', () => {
    const r = readUnresolvableEdges(spawn({ stdout: '  31 edges could not be resolved\n' }));
    expect(r).toEqual({ measured: null });
    expect(r.blocked).toBeUndefined();
  });

  it('reports measured:null for a clean exit with no output at all', () => {
    expect(readUnresolvableEdges(spawn({ stdout: '' }))).toEqual({ measured: null });
  });
});

describe('a tool that never got to speak is blocked, not failed', () => {
  it('names the signal that killed it', () => {
    const r = readUnresolvableEdges(spawn({ status: null, signal: 'SIGKILL' }));
    expect(r.blocked).toBe('archmap was killed by SIGKILL before it printed its stats');
    expect(r.measured).toBeUndefined();
  });

  it("names node's own spawn error, not only ENOENT", () => {
    const r = readUnresolvableEdges(spawn({ error: { code: 'ENOBUFS' }, stdout: 'truncat' }));
    expect(r.blocked).toBe('archmap could not be run — ENOBUFS');
  });

  it('names the exit status when it printed no stats, and carries stderr as description', () => {
    const r = readUnresolvableEdges(
      spawn({ status: 2, stderr: '\n  cannot open .arch.json\nmore detail\n' }),
    );
    expect(r.blocked).toBe(
      'archmap check --stats exited 2 and printed no stats — cannot open .arch.json',
    );
  });

  it('says only the status where there is no stderr to describe it', () => {
    expect(readUnresolvableEdges(spawn({ status: 2 })).blocked).toBe(
      'archmap check --stats exited 2 and printed no stats',
    );
  });

  // The structural signals decide; stderr never does. A run that PRINTED its stats and also
  // complained on stderr is a reading, not a blockage.
  it('does not let stderr alone block a run that printed its stats', () => {
    expect(
      readUnresolvableEdges(spawn({ stdout: REAL_STATS, stderr: 'could not resolve a module' })),
    ).toEqual({ measured: 31 });
  });
});
