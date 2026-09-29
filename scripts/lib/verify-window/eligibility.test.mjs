import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.mjs';
import { judgeEligibility, parseDiff } from './eligibility.mjs';

const { config } = parseConfig(
  JSON.stringify({
    check: 'ci-passed',
    migrations: { dir: 'db/migrations' },
    ineligible: {
      paths: [{ glob: 'runner/**', reason: 'runs on three platforms' }],
      linesIn: ['**/*.mjs'],
      lines: [
        { pattern: 'process\\.env\\.PATH\\b', reason: 'PATH is read by every child process' },
      ],
    },
  }),
  'fixture',
);

const diff = [
  'diff --git a/src/a.mjs b/src/a.mjs',
  'index 1..2 100644',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -3,0 +4,2 @@ context',
  '+const x = 1;',
  "+process.env.PATH = '/tmp';",
  'diff --git a/docs/a.md b/docs/a.md',
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -1 +1 @@',
  '-old',
  '+Never set process.env.PATH in a test.',
  'diff --git a/runner/src/main.rs b/runner/src/main.rs',
  'deleted file mode 100644',
  '--- a/runner/src/main.rs',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-fn main() {}',
].join('\n');

describe('parseDiff', () => {
  it('numbers each added line as it stands in the new file', () => {
    const [a] = parseDiff(diff);
    expect(a.path).toBe('src/a.mjs');
    expect(a.added).toEqual([
      { line: 4, text: 'const x = 1;' },
      { line: 5, text: "process.env.PATH = '/tmp';" },
    ]);
  });

  it('keeps a deleted file among the touched paths', () => {
    expect(parseDiff(diff).map((f) => f.path)).toContain('runner/src/main.rs');
  });
});

describe('judgeEligibility', () => {
  const refusals = judgeEligibility({ issue: 'ISS-9', files: parseDiff(diff) }, config);

  it('refuses a touched ineligible path with the declared reason', () => {
    expect(refusals.find((r) => r.surface === 'path').message).toBe(
      'ISS-9 touches runner/src/main.rs, which `runner/**` declares ineligible: runs on three platforms',
    );
  });

  it('refuses an added line matching a pattern, naming the file and line', () => {
    expect(refusals.find((r) => r.surface === 'line').message).toMatch(
      /^ISS-9 adds src\/a\.mjs:5 `process\.env\.PATH = '\/tmp';`, which matches .*: PATH is read by every child process$/,
    );
  });

  it('reads no line rule in a file outside the declared scope', () => {
    expect(refusals.some((r) => r.file === 'docs/a.md')).toBe(false);
  });

  it('admits a diff that touches no declared surface', () => {
    const clean = parseDiff('diff --git a/src/b.mjs b/src/b.mjs\n@@ -1 +1 @@\n+const y = 2;');
    expect(judgeEligibility({ issue: 'ISS-8', files: clean }, config)).toEqual([]);
  });
});
