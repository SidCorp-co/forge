import { describe, expect, it } from 'vitest';
import { fnHitsAt, lookup, mergeSites, parseSites, stmtHitsAt } from './flow-coverage.mjs';

// cm:why the fixture is tryDispatchCoolifyRelease reduced: `f`=3 with the annotated statement's `s`=0 is the real shape ISS-955 found, so a change that makes these two agree here has merged the levels rather than fixed the fixture
const entry = {
  fnMap: {
    0: {
      name: 'tryDispatch',
      decl: { start: { line: 11 } },
      loc: { start: { line: 11 }, end: { line: 30 } },
    },
  },
  f: { 0: 3 },
  statementMap: {
    0: { start: { line: 12 }, end: { line: 14 } },
    1: { start: { line: 20 }, end: { line: 20 } },
  },
  s: { 0: 3, 1: 0 },
};

const source = (data) => ({ label: 'e2e', authoritative: true, data });

describe('fnHitsAt', () => {
  it('reads the invocation count of the tightest function at or below the annotation', () => {
    expect(fnHitsAt(entry, 10)).toEqual({ span: 19, hits: 3, name: 'tryDispatch' });
  });

  it('finds nothing when no function is within the lookahead', () => {
    expect(fnHitsAt(entry, 100)).toBeNull();
  });
});

describe('stmtHitsAt', () => {
  it('takes the nearest statement at or below the annotation, not the enclosing one', () => {
    expect(stmtHitsAt(entry, 11)).toEqual({ line: 12, hits: 3 });
  });

  it('reports zero for a statement the suite never executed', () => {
    expect(stmtHitsAt(entry, 19)).toEqual({ line: 20, hits: 0 });
  });

  it('finds nothing above the first statement it could name', () => {
    expect(stmtHitsAt(entry, 100)).toBeNull();
  });
});

describe('lookup', () => {
  // cm:guard this is the distinction ISS-955 exists to keep visible: `state` is the GATE's verdict and stays function-level, `stmt` is the advisory. If a change makes these two agree on this fixture, the two evidence levels have been merged and the report is back to overstating itself.
  it('reports a function entered whose annotated statement never ran as covered AND statement-uncovered', () => {
    const r = lookup(source({ '/repo/packages/core/src/a.ts': entry }), {
      file: 'packages/core/src/a.ts',
      line: 19,
    });
    expect(r.state).toBe('covered');
    expect(r.hits).toBe(3);
    expect(r.stmt).toBe('uncovered');
    expect(r.stmtHits).toBe(0);
  });

  it('agrees on both levels when the annotated statement did run', () => {
    const r = lookup(source({ '/repo/packages/core/src/a.ts': entry }), {
      file: 'packages/core/src/a.ts',
      line: 11,
    });
    expect(r.state).toBe('covered');
    expect(r.stmt).toBe('covered');
  });

  it('reports a function nothing entered as uncovered on both levels', () => {
    const cold = { ...entry, f: { 0: 0 }, s: { 0: 0, 1: 0 } };
    const r = lookup(source({ '/repo/packages/core/src/a.ts': cold }), {
      file: 'packages/core/src/a.ts',
      line: 11,
    });
    expect(r.state).toBe('uncovered');
    expect(r.stmt).toBe('uncovered');
  });

  it('matches a report keyed without the package prefix', () => {
    const r = lookup(source({ '/repo/src/a.ts': entry }), {
      file: 'packages/core/src/a.ts',
      line: 11,
    });
    expect(r.state).toBe('covered');
  });

  it('says nosource for an absent report and outofscope for an unlisted file', () => {
    expect(lookup({ missing: true }, { file: 'a.ts', line: 1 }).state).toBe('nosource');
    expect(lookup(source({}), { file: 'a.ts', line: 1 }).state).toBe('outofscope');
  });
});

describe('mergeSites', () => {
  it('keeps each level covered independently across sites', () => {
    const a = [{ state: 'covered', stmt: 'uncovered' }];
    const b = [{ state: 'uncovered', stmt: 'covered' }];
    expect(mergeSites(a, b)).toEqual([{ state: 'covered', stmt: 'covered' }]);
  });

  it('returns the first site unchanged', () => {
    const per = [{ state: 'covered', stmt: 'covered' }];
    expect(mergeSites(null, per)).toBe(per);
  });
});

describe('parseSites', () => {
  // cm:guard build the marker at runtime, never as a literal — check-flow-coverage finds its sites with `git grep cm:flow` over TRACKED files, so a literal here is a real annotation to the gate the moment this file is committed. It cost one red CI run: the fixture's `release/tick` made the step scan find 5 where `cm flow release` reports 4, and the checker exits 2 on that disagreement.
  const MARK = `cm${':'}flow`;

  it('keeps only the flows it was asked for', () => {
    const out = [
      `packages/core/src/a.ts:11:// ${MARK} release/deploy — dispatches`,
      `packages/core/src/b.ts:4:// ${MARK} other/step — not asked for`,
      `packages/core/src/c.ts:notanumber:// ${MARK} release/tick`,
    ].join('\n');
    const byFlow = parseSites(out, ['release']);
    expect(byFlow.get('release')).toEqual([
      { flow: 'release', step: 'deploy', file: 'packages/core/src/a.ts', line: 11 },
    ]);
    expect(byFlow.has('other')).toBe(false);
  });
});
