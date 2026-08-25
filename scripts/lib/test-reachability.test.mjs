import { describe, expect, it } from 'vitest';
import { isSuiteSkip, judge } from './test-reachability.mjs';

const base = {
  testFiles: ['a.test.ts'],
  collectedPerRunner: { 'vitest.config.ts': ['a.test.ts'] },
  declaredSkips: {},
  skipHits: [],
};

describe('judge', () => {
  it('passes when every tracked file is collected', () => {
    expect(judge(base).code).toBe(0);
  });

  it('fails on a file no runner collects', () => {
    const v = judge({ ...base, testFiles: ['a.test.ts', 'orphan.test.ts'] });
    expect(v.code).toBe(1);
    expect(v.unreachable).toEqual(['orphan.test.ts']);
  });

  it('counts a file collected by ANY runner, not by all of them', () => {
    const v = judge({
      ...base,
      testFiles: ['a.test.ts', 'b.test.ts'],
      collectedPerRunner: { unit: ['a.test.ts'], integration: ['b.test.ts'] },
    });
    expect(v.code).toBe(0);
  });

  // cm:guard this is the whole reason judge() exists as its own function. A runner that cannot answer must be exit 2 — "the gate could not run" — and NEVER exit 1 with a violation list, because that list would name every file the broken runner owns and read as a real finding. Two of this repo's gates shipped with the mirror-image bug: an empty measurement reported as a clean pass.
  it('is exit 2, not a violation list, when a runner could not answer', () => {
    const v = judge({
      ...base,
      testFiles: ['a.test.ts', 'b.test.ts'],
      collectedPerRunner: { unit: ['a.test.ts'], integration: null },
    });
    expect(v.code).toBe(2);
    expect(v.reason).toContain('integration');
    expect(v.unreachable).toBeUndefined();
  });

  it('is exit 2 when there is no runner at all', () => {
    expect(judge({ ...base, collectedPerRunner: {} }).code).toBe(2);
  });

  it('is exit 2 when the skips file is unreadable', () => {
    expect(judge({ ...base, declaredSkips: null }).code).toBe(2);
  });

  it('fails on a whole-suite skip nobody declared', () => {
    const v = judge({ ...base, skipHits: ['a.test.ts'] });
    expect(v.code).toBe(1);
    expect(v.undeclaredSkips).toEqual(['a.test.ts']);
  });

  it('accepts a skip that carries a declared reason', () => {
    const v = judge({
      ...base,
      skipHits: ['a.test.ts'],
      declaredSkips: { 'a.test.ts': 'needs live embeddings credentials' },
    });
    expect(v.code).toBe(0);
  });

  // cm:guard an unreachable file must not ALSO be reported as an undeclared skip. It is already named once, and naming it twice pushes whoever reads the output toward declaring a skip for a file that no runner even collects — which would silence the real finding.
  it('reports an unreachable file once, not also as a skip', () => {
    const v = judge({
      ...base,
      testFiles: ['a.test.ts', 'dead.test.ts'],
      skipHits: ['dead.test.ts'],
    });
    expect(v.unreachable).toEqual(['dead.test.ts']);
    expect(v.undeclaredSkips).toEqual([]);
  });
});

describe('isSuiteSkip', () => {
  // cm:guard these two lines are verbatim what the device-runner E2E and memory-live carried. If a refactor makes the detector stop matching them, this gate goes quiet on exactly the shape it was built for and nothing else will say so.
  it('matches the two forms this repo actually used', () => {
    expect(isSuiteSkip("describe.skipIf(!runE2E)('F2 device-runner E2E', () => {")).toBe(true);
    expect(isSuiteSkip('const describeIfLive = HAS_LIVE_ENV ? describe : describe.skip;')).toBe(
      true,
    );
  });

  it('matches a plain skipped suite, a todo suite, and an indented one', () => {
    expect(isSuiteSkip("describe.skip('IssueBlockedBanner', () => {")).toBe(true);
    expect(isSuiteSkip("describe.todo('later');")).toBe(true);
    expect(isSuiteSkip("    describe.skip('nested', () => {")).toBe(true);
    expect(isSuiteSkip('export const d = cond ? describe : describe.skip;')).toBe(true);
  });

  // cm:guard `it.skip` must NOT match. Quarantining one case is visible in the run summary as a skipped test; treating it as a whole-file skip would put every ordinary quarantine through the declaration file and get the rule switched off.
  it('leaves a single quarantined case alone', () => {
    expect(isSuiteSkip("  it.skip('flaky under load', () => {")).toBe(false);
    expect(isSuiteSkip("  test.skip('later', () => {")).toBe(false);
  });

  it('does not fire on an ordinary describe', () => {
    expect(isSuiteSkip("describe('dispatchChatTurn', () => {")).toBe(false);
  });

  // cm:guard the regression that made this a function instead of a bare regex. The unanchored pattern flagged THIS file, because a test for a skip detector has to quote skip syntax. Caught before it was tracked; without the anchor the fix would have been an exemption entry, and an exemption is where the next real skip hides.
  it('ignores skip syntax quoted inside an argument', () => {
    expect(isSuiteSkip('expect(isSuiteSkip("describe.skip(\'x\', () => {")).toBe(true);')).toBe(
      false,
    );
    expect(isSuiteSkip("expect(hits('const d = C ? describe : describe.skip;')).toBe(true);")).toBe(
      false,
    );
    expect(isSuiteSkip('// the device-runner E2E used describe.skipIf(!runE2E) for months')).toBe(
      false,
    );
  });
});
