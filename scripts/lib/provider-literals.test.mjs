import { describe, expect, it } from 'vitest';
import {
  allowedFaults,
  byFile,
  coverageFaults,
  globToRegExp,
  isAllowed,
  scanEntries,
  stringLiterals,
} from './provider-literals.mjs';

const PROVIDERS = ['coolify', 'postman', 'epodsystem', 'sentry', 'rocketchat', 'github', 'google'];
const ALLOWED = [
  { glob: 'packages/core/src/integrations/coolify/**', why: "the provider's own directory" },
  { glob: 'packages/core/src/integrations/registry.ts', why: 'the registry' },
  { glob: 'packages/core/src/db/**', why: "the schema's own vocabulary" },
];

const scan = (entries) => scanEntries(entries, { providers: PROVIDERS, allowed: ALLOWED });

describe('stringLiterals', () => {
  it('reads all three quote forms', () => {
    const text = `const a = 'coolify';\nconst b = "postman";\nconst c = \`sentry\`;\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['coolify', 'postman', 'sentry']);
  });

  it('reports the line each literal was written on', () => {
    const text = `const a = 1;\n\nconst b = 'github';\n`;
    expect(stringLiterals(text)).toEqual([{ value: 'github', line: 3 }]);
  });

  // The rule this repo's own prose depends on: `registry.ts` explains the retired
  // `startsWith('epodsystem_')` gate by quoting it, and a scan that accused its own
  // documentation would be uninhabitable inside a week.
  it('reads nothing out of a line comment', () => {
    expect(stringLiterals(`// the old gate was startsWith('epodsystem_')\n`)).toEqual([]);
  });

  it('reads nothing out of a block comment, and keeps counting its lines', () => {
    const text = `/*\n * 'coolify' used to be branched on here\n */\nconst x = 'sentry';\n`;
    expect(stringLiterals(text)).toEqual([{ value: 'sentry', line: 4 }]);
  });

  it('reads a `//` inside a string as part of the string, not as a comment', () => {
    const text = `const u = 'https://example.com/x';\nconst p = 'postman';\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['https://example.com/x', 'postman']);
  });

  it('splits a template at each substitution, so a static prefix is its own literal', () => {
    const text = `const n = \`epodsystem_\${label}_suffix\`;\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['epodsystem_', '_suffix']);
  });

  it('reads a literal written inside a template substitution', () => {
    const text = `const n = \`x\${pick('sentry')}y\`;\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['x', 'sentry', 'y']);
  });

  it('unwinds nested braces inside a substitution before the template resumes', () => {
    const text = `const n = \`a\${ {k: 1}.k }coolify\`;\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['a', 'coolify']);
  });

  it('reads a nested template inside a substitution without ending the outer one', () => {
    const text = `const n = \`a\${\`github\`}b\`;\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(['a', 'github', 'b']);
  });

  it('keeps an escaped quote inside the literal rather than closing on it', () => {
    const text = `const s = 'it\\'s coolify';\nconst t = 'postman';\n`;
    expect(stringLiterals(text).map((s) => s.value)).toEqual(["it's coolify", 'postman']);
  });

  // cm:guard the bound stated at the top of the lib: a quote inside a regex literal is
  // indistinguishable from a string without a parser, and the ONLY acceptable failure is a
  // missed literal. An invented one would accuse a file of something it does not contain.
  it('invents no literal out of a regex whose quote never closes, and realigns on the next line', () => {
    const text = `const re = /['"]/;\nconst p = 'coolify';\n`;
    expect(stringLiterals(text)).toEqual([{ value: 'coolify', line: 2 }]);
  });
});

describe('globToRegExp', () => {
  it('lets `**` cross path separators', () => {
    expect(globToRegExp('packages/core/src/db/**').test('packages/core/src/db/a/b/c.ts')).toBe(
      true,
    );
  });

  it('does not let a single `*` cross a path separator', () => {
    expect(globToRegExp('packages/*/src').test('packages/core/extra/src')).toBe(false);
  });

  it('anchors at both ends, so a prefix match is not a match', () => {
    expect(globToRegExp('packages/core/src/x.ts').test('other/packages/core/src/x.ts')).toBe(false);
    expect(globToRegExp('packages/core/src/x.ts').test('packages/core/src/x.ts.bak')).toBe(false);
  });

  // A glob language that quietly honoured regex metacharacters would let one allowlist line
  // admit far more than the person who wrote it read.
  it('reads a dot as a dot and not as any character', () => {
    expect(globToRegExp('a/b.ts').test('a/bXts')).toBe(false);
    expect(globToRegExp('a/b.ts').test('a/b.ts')).toBe(true);
  });
});

describe('isAllowed', () => {
  it('admits a file under a declared subtree', () => {
    expect(isAllowed('packages/core/src/integrations/coolify/client.ts', ALLOWED)).toBe(true);
  });

  it('refuses a sibling of a declared file', () => {
    expect(isAllowed('packages/core/src/integrations/routes.ts', ALLOWED)).toBe(false);
  });
});

describe('allowedFaults', () => {
  it('passes a list where every entry carries a reason', () => {
    expect(allowedFaults(ALLOWED)).toEqual([]);
  });

  // ISS-1071's own acceptance criterion: each declared allowed location carries the reason it
  // is allowed. An allowlist is where a rule goes to die quietly, and a line nobody can read the
  // reason for is a line nobody can retire.
  it('names the glob of an entry whose `why` is missing', () => {
    const faults = allowedFaults([{ glob: 'packages/core/src/anything/**' }]);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('packages/core/src/anything/**');
  });

  it('names the glob of an entry whose `why` is whitespace', () => {
    expect(allowedFaults([{ glob: 'a/**', why: '   ' }])[0]).toContain('a/**');
  });

  it('faults an entry that declares no glob at all', () => {
    expect(allowedFaults([{ why: 'a reason with nothing it applies to' }])[0]).toContain('entry 0');
  });

  it('faults a list that is not a list', () => {
    expect(allowedFaults(undefined)).toHaveLength(1);
  });
});

describe('coverageFaults', () => {
  it('passes when every declared provider is scanned', () => {
    expect(coverageFaults(PROVIDERS, PROVIDERS, [])).toEqual([]);
  });

  it('passes a provider that is excused with a reason', () => {
    const excused = [{ provider: 'agent', why: 'the word is also the actor vocabulary' }];
    expect(coverageFaults([...PROVIDERS, 'agent'], PROVIDERS, excused)).toEqual([]);
  });

  // This is what stops a provider leaving the scan by being forgotten rather than by being
  // argued about: an eighth name added to the union with neither entry exits 2, instead of
  // producing a smaller scan that still prints a count and still reads as green.
  it('names a declared provider that is in neither list', () => {
    const faults = coverageFaults([...PROVIDERS, 'agent'], PROVIDERS, []);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('agent');
  });

  it('names an excused provider whose reason is empty', () => {
    const faults = coverageFaults(['agent'], [], [{ provider: 'agent', why: '' }]);
    expect(faults.some((f) => f.includes('agent'))).toBe(true);
  });
});

describe('scanEntries', () => {
  it('reports a provider named outside every allowed location', () => {
    const { offenders } = scan([
      { path: 'packages/core/src/pipeline/release.ts', text: `if (p === 'coolify') return 1;\n` },
    ]);
    expect(offenders).toEqual([
      { path: 'packages/core/src/pipeline/release.ts', line: 1, provider: 'coolify' },
    ]);
  });

  it('reports nothing inside a declared allowed location', () => {
    const { offenders } = scan([
      { path: 'packages/core/src/integrations/coolify/client.ts', text: `const p = 'coolify';\n` },
    ]);
    expect(offenders).toEqual([]);
  });

  // The bound the lib states, pinned so that widening it later is a deliberate edit to this
  // test rather than a quiet change of meaning: a display label and a log line name a provider
  // to a human, and neither of them dispatches on anything.
  it('reports neither a display label nor a name embedded in a message', () => {
    const { offenders } = scan([
      { path: 'a/b.ts', text: `const label = 'Coolify';\nthrow new Error('coolify: failed');\n` },
    ]);
    expect(offenders).toEqual([]);
  });

  it('counts every file it read, including the ones it was not allowed to judge', () => {
    const { scanned } = scan([
      { path: 'packages/core/src/integrations/coolify/a.ts', text: `'coolify'` },
      { path: 'packages/core/src/x.ts', text: 'const a = 1;' },
    ]);
    expect(scanned).toBe(2);
  });

  it('counts zero on an empty input, so its caller can refuse to report clean', () => {
    expect(scan([])).toEqual({ scanned: 0, offenders: [] });
  });

  it('reports every provider in a file rather than stopping at the first', () => {
    const text = `const m = { a: 'coolify', b: 'sentry', c: 'github' };\n`;
    const { offenders } = scan([{ path: 'a/b.ts', text }]);
    expect(offenders.map((o) => o.provider)).toEqual(['coolify', 'sentry', 'github']);
  });
});

describe('byFile', () => {
  it('groups a file once, with its providers sorted and its lines deduplicated', () => {
    const grouped = byFile([
      { path: 'b.ts', line: 3, provider: 'sentry' },
      { path: 'a.ts', line: 9, provider: 'github' },
      { path: 'a.ts', line: 9, provider: 'github' },
      { path: 'a.ts', line: 2, provider: 'coolify' },
    ]);
    expect(grouped).toEqual([
      { path: 'a.ts', providers: ['coolify', 'github'], lines: [2, 9] },
      { path: 'b.ts', providers: ['sentry'], lines: [3] },
    ]);
  });
});
