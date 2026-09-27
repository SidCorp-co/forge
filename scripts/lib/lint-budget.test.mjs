import { describe, expect, it } from 'vitest';
import { freezeFaults } from './debt-ratchet.mjs';
import {
  drainedLine,
  drainFaults,
  drainMatcher,
  emptiedScopes,
  explainFaults,
  mergeOriginal,
  messageLines,
  NO_MESSAGE,
  readDiagnostic,
} from './lint-budget.mjs';

const CORE = {
  cwd: 'packages/core',
  drain: { include: '^packages/core/src/', exclude: '\\.test\\.tsx?$' },
};
const matchers = [drainMatcher(CORE)];

/** The one argument shape drainFaults takes, with only the interesting part varying. */
const drain = ({ measured = {}, baseline = {}, changed = [], renamed = new Map() }) =>
  drainFaults({ measured, baseline, changed: new Set(changed), renamed, matchers });

describe('drain', () => {
  it('refuses a touched debt-carrying file whose count did not move', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 3 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toHaveLength(1);
    expect(faults[0].reasons[0]).toContain('leave it strictly lower');
  });

  it('accepts a payment of one', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 2 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toEqual([]);
  });

  it('sums a payment across rules, so trading one rule for another is not a payment', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 1, other: 2 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults).toHaveLength(1);
  });

  it('holds a file already at zero at zero', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 1 } },
      baseline: { 'packages/core/src/a.ts': {} },
      changed: ['packages/core/src/a.ts'],
    });
    expect(faults[0].reasons[0]).toContain('a file at zero stays at zero');
  });

  it('requires a new drainable file to be clean', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 1 } },
      changed: ['packages/core/src/new.ts'],
    });
    expect(faults).toHaveLength(1);
  });

  it('asks nothing of a new drainable file that is clean', () => {
    expect(drain({ changed: ['packages/core/src/new.ts'] })).toEqual([]);
  });

  it('never asks a test file to pay', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.test.ts': { r: 9 } },
      baseline: { 'packages/core/src/a.test.ts': { r: 9 } },
      changed: ['packages/core/src/a.test.ts'],
    });
    expect(faults).toEqual([]);
  });

  it('never asks a scope with no drain declaration to pay', () => {
    const faults = drainFaults({
      measured: { 'packages/web-v2/src/a.tsx': { r: 9 } },
      baseline: { 'packages/web-v2/src/a.tsx': { r: 9 } },
      changed: new Set(['packages/web-v2/src/a.tsx']),
      renamed: new Map(),
      matchers: [drainMatcher({ cwd: 'packages/web-v2' })].filter(Boolean),
    });
    expect(faults).toEqual([]);
  });

  it('lets a rename carry its debt through unpaid', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 3 } },
      baseline: { 'packages/core/src/old.ts': { r: 3 } },
      changed: ['packages/core/src/new.ts'],
      renamed: new Map([['packages/core/src/new.ts', 'packages/core/src/old.ts']]),
    });
    expect(faults).toEqual([]);
  });

  it('refuses a rename that gained debt on the way', () => {
    const faults = drain({
      measured: { 'packages/core/src/new.ts': { r: 4 } },
      baseline: { 'packages/core/src/old.ts': { r: 3 } },
      changed: ['packages/core/src/new.ts'],
      renamed: new Map([['packages/core/src/new.ts', 'packages/core/src/old.ts']]),
    });
    expect(faults[0].reasons[0]).toContain('a move may not add debt');
  });

  it('refuses a drain block with no include pattern', () => {
    expect(() => drainMatcher({ cwd: 'p', drain: {} })).toThrow('declares no include pattern');
  });

  it('refuses a drain pattern that will not compile', () => {
    expect(() => drainMatcher({ cwd: 'p', drain: { include: '^(' } })).toThrow();
  });

  it('asks nothing of a file outside the branch delta', () => {
    const faults = drain({
      measured: { 'packages/core/src/a.ts': { r: 3 } },
      baseline: { 'packages/core/src/a.ts': { r: 3 } },
      changed: [],
    });
    expect(faults).toEqual([]);
  });
});

describe('original', () => {
  it('keeps an existing original when the current count is lower', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['a', 215]]))).toEqual({ a: 226 });
  });

  it('keeps an existing original when the current count is higher', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['a', 900]]))).toEqual({ a: 226 });
  });

  it('seeds a scope it has never seen', () => {
    expect(mergeOriginal({ a: 226 }, new Map([['b', 12]]))).toEqual({ a: 226, b: 12 });
  });

  it('reports the drained percentage against the original, not the baseline', () => {
    expect(drainedLine('a', 215, 226)).toBe('  a: 215 / 226 original (5% drained)');
  });

  it('says so rather than dividing by nothing', () => {
    expect(drainedLine('a', 215, undefined)).toBe('  a: 215 (no original recorded)');
  });
});

describe('emptiedScopes', () => {
  const at = (o) => new Map(Object.entries(o));

  it('refuses a scope that measured nothing while its baseline holds debt', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 0 }), at({ 'packages/web-v2': 210 }))).toEqual([
      'packages/web-v2',
    ]);
  });

  it('asks nothing of a scope already frozen at zero', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 0 }), at({ 'packages/web-v2': 0 }))).toEqual([]);
  });

  it('ignores a scope that still measures debt', () => {
    expect(emptiedScopes(at({ 'packages/core': 277 }), at({ 'packages/core': 280 }))).toEqual([]);
  });

  it('names every emptied scope, not just the first', () => {
    expect(emptiedScopes(at({ a: 0, b: 0, c: 5 }), at({ a: 1, b: 2, c: 5 }))).toEqual(['a', 'b']);
  });

  it('treats a scope absent from the baseline as nothing to protect', () => {
    expect(emptiedScopes(at({ 'packages/new': 0 }), at({}))).toEqual([]);
  });

  it('does NOT catch a scope emptied in part — declared, not closed', () => {
    expect(emptiedScopes(at({ 'packages/web-v2': 186 }), at({ 'packages/web-v2': 210 }))).toEqual(
      [],
    );
    expect(emptiedScopes(at({ 'packages/web-v2': 1 }), at({ 'packages/web-v2': 210 }))).toEqual([]);
  });
});

const BOUNDARY =
  "react-hook-form is a behaviour library web-v2 keeps behind its own design system (ISS-1172). Import it only inside src/design/**, and give features a component or hook from @/design that passes their own types, never the library's.";

/** The shape biome 2.5.9's --reporter=json printed for a restricted import planted in web-v2. */
const planted = (overrides = {}) => ({
  severity: 'error',
  message: BOUNDARY,
  category: 'lint/style/noRestrictedImports',
  location: {
    path: 'src/features/zz-probe/x.tsx',
    start: { line: 1, column: 25 },
    end: { line: 1, column: 42 },
  },
  advices: [],
  ...overrides,
});

describe('readDiagnostic', () => {
  it("keeps biome's message and line beside the rule and path it counts by", () => {
    expect(readDiagnostic(planted())).toEqual({
      rule: 'lint/style/noRestrictedImports',
      path: 'src/features/zz-probe/x.tsx',
      line: 1,
      message: BOUNDARY,
    });
  });

  it('reads the older object-shaped path', () => {
    const d = planted({ location: { path: { file: 'src/a.ts' }, start: { line: 4 } } });
    expect(readDiagnostic(d)).toMatchObject({ path: 'src/a.ts', line: 4 });
  });

  it('marks an absent or blank message as null rather than inventing one', () => {
    expect(readDiagnostic(planted({ message: undefined })).message).toBeNull();
    expect(readDiagnostic(planted({ message: '   ' })).message).toBeNull();
    expect(readDiagnostic(planted({ location: { path: 'src/a.ts' } })).line).toBeNull();
  });

  it('counts nothing for a length rule, a missing category or a missing path', () => {
    expect(readDiagnostic(planted({ category: 'lint/style/noExcessiveLinesPerFile' }))).toBeNull();
    expect(readDiagnostic(planted({ category: undefined }))).toBeNull();
    expect(readDiagnostic(planted({ location: {} }))).toBeNull();
  });
});

describe('messageLines', () => {
  it('prints one shared message once, with every line it was reported at, in order', () => {
    const said = [
      { line: 9, message: 'm' },
      { line: 2, message: 'm' },
    ];
    expect(messageLines(said)).toEqual(['lines 2, 9: m']);
  });

  it('keeps distinct messages apart', () => {
    const said = [
      { line: 1, message: 'a' },
      { line: 2, message: 'b' },
    ];
    expect(messageLines(said)).toEqual(['line 1: a', 'line 2: b']);
  });

  it('says biome gave no message rather than leaving the diagnostic out', () => {
    expect(messageLines([{ line: 3, message: null }])).toEqual([`line 3: ${NO_MESSAGE}`]);
  });

  it('prints a message with no line bare, and folds a multi-line message onto one', () => {
    expect(messageLines([{ line: null, message: 'first\n  second' }])).toEqual(['first second']);
  });
});

describe('explainFaults', () => {
  it("puts biome's message under the rule that rose and under no other", () => {
    const measured = { 'x.tsx': { 'lint/style/noRestrictedImports': 1, 'lint/a': 2 } };
    const baseline = { 'x.tsx': { 'lint/a': 2 } };
    const said = {
      'x.tsx': {
        'lint/style/noRestrictedImports': [{ line: 1, message: BOUNDARY }],
        'lint/a': [
          { line: 5, message: 'frozen debt' },
          { line: 6, message: 'frozen debt' },
        ],
      },
    };
    expect(explainFaults(freezeFaults(measured, baseline), said)).toEqual([
      {
        file: 'x.tsx',
        reasons: [
          'lint/style/noRestrictedImports: 1 (baseline allowed 0)',
          `  line 1: ${BOUNDARY}`,
        ],
      },
    ]);
  });

  it('leaves the count line exactly as the freeze wrote it', () => {
    const measured = { 'x.tsx': { r: 2 } };
    const said = {
      'x.tsx': {
        r: [
          { line: 1, message: 'm' },
          { line: 4, message: 'm' },
        ],
      },
    };
    const [fault] = explainFaults(freezeFaults(measured, { 'x.tsx': { r: 1 } }), said);
    expect(fault.reasons).toEqual(['r: 2 (baseline allowed 1)', '  lines 1, 4: m']);
  });
});
