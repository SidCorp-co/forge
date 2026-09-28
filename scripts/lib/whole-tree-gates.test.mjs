import { describe, expect, it } from 'vitest';
import {
  declarationExit,
  declarationsIn,
  deepestClimb,
  ENUMERATES_RE,
  judgeDeclarations,
  judgeRun,
  reachesRoot,
} from './whole-tree-gates.mjs';

// Every probe source is assembled from these pieces, so no line of THIS file reads as a climb, an
// enumeration or a declaration to the checker that scans it.
const UP = `'${'.'.repeat(2)}'`;
const LIST = `readdir${'Sync'}`;
const MARK = `@gate-${'input'}`;
const TOPLEVEL = `git rev-parse --show-${'toplevel'}`;
const LS_FILES = `git('ls-${'files'}')`;

const up = (n) => Array.from({ length: n }, () => UP).join(', ');
const walker = (n) =>
  [
    "import { join } from 'node:path';",
    `const ROOT = join(import.meta.dirname, ${up(n)});`,
    `const files = ${LIST}(ROOT);`,
  ].join('\n');
const declared = (value, body = walker(4)) =>
  [`/**`, ` * ${MARK} ${value}`, ` */`, body].join('\n');
const WALKER_PATH = 'packages/core/src/pipeline/walks.test.ts';

describe('reading a declaration', () => {
  it('finds one in a docblock and one after //, with the line each sits on', () => {
    expect(declarationsIn(declared('whole-tree'))).toEqual([{ value: 'whole-tree', line: 2 }]);
    expect(declarationsIn(`x();\n// ${MARK} whole-tree`)).toEqual([
      { value: 'whole-tree', line: 2 },
    ]);
  });

  it('does not read one that is only quoted mid-line', () => {
    expect(declarationsIn(`const s = "// ${MARK} whole-tree";`)).toEqual([]);
  });
});

describe('what a path expression climbs', () => {
  it('counts a run of dot-dot arguments', () => {
    expect(deepestClimb(`join(here, ${up(4)})`)).toBe(4);
  });

  it('counts a literal of dot-dot segments, with or without a tail', () => {
    const tail = `'${'../'.repeat(3)}contracts/package.json'`;
    expect(deepestClimb(`resolve(here, '${'../'.repeat(3)}..')`)).toBe(4);
    expect(deepestClimb(`new URL(${tail}, import.meta.url)`)).toBe(3);
  });

  it('reaches the root from four deep with four, and not with three', () => {
    expect(reachesRoot(WALKER_PATH, walker(4))).toBe(true);
    expect(reachesRoot(WALKER_PATH, walker(3))).toBe(false);
  });

  it('reaches the root through git itself', () => {
    expect(reachesRoot(WALKER_PATH, TOPLEVEL)).toBe(true);
  });

  it('knows a listing call from a single read', () => {
    expect(ENUMERATES_RE.test(`${LIST}(dir)`)).toBe(true);
    expect(ENUMERATES_RE.test(LS_FILES)).toBe(true);
    expect(ENUMERATES_RE.test('readFileSync(path)')).toBe(false);
  });
});

describe('judging the declarations', () => {
  it('selects a declared test wherever it lives, since the declaration moves with it', () => {
    const files = [
      { path: WALKER_PATH, source: declared('whole-tree') },
      { path: 'packages/web-v2/src/moved/walks.test.ts', source: declared('whole-tree') },
    ];
    const out = judgeDeclarations({ files });
    expect(out.declared).toEqual([
      'packages/core/src/pipeline/walks.test.ts',
      'packages/web-v2/src/moved/walks.test.ts',
    ]);
    expect(out.refused).toEqual([]);
    expect(declarationExit(out)).toBe(0);
  });

  it('refuses an undeclared test that walks from the root, naming the line to add', () => {
    const out = judgeDeclarations({ files: [{ path: WALKER_PATH, source: walker(4) }] });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].path).toBe(WALKER_PATH);
    expect(out.refused[0].why).toContain(`// ${MARK} whole-tree`);
    expect(declarationExit(out)).toBe(1);
  });

  it('lets an undeclared test through that reaches the root but lists nothing', () => {
    const source = `const ROOT = join(import.meta.dirname, ${up(4)});\nreadFileSync(ROOT);`;
    const out = judgeDeclarations({ files: [{ path: WALKER_PATH, source }] });
    expect(out.refused).toEqual([]);
  });

  it('lets an undeclared test through that lists a directory inside its own package', () => {
    const out = judgeDeclarations({ files: [{ path: WALKER_PATH, source: walker(1) }] });
    expect(out.refused).toEqual([]);
  });

  it('does not ask a file that is not a test to declare anything', () => {
    const out = judgeDeclarations({ files: [{ path: 'scripts/walks.mjs', source: walker(1) }] });
    expect(out.refused).toEqual([]);
    expect(out.tests).toBe(0);
  });

  it('refuses a value other than whole-tree, naming the value and the valid shape', () => {
    const out = judgeDeclarations({
      files: [{ path: WALKER_PATH, source: declared('wholetree') }],
    });
    expect(out.declared).toEqual([]);
    expect(out.refused[0].why).toBe(
      `line 2 declares \`${MARK} wholetree\`, and the only valid shape is \`${MARK} whole-tree\``,
    );
  });

  it('refuses a declaration with no value at all', () => {
    const out = judgeDeclarations({ files: [{ path: WALKER_PATH, source: declared('') }] });
    expect(out.refused[0].why).toContain(`${MARK} (nothing)`);
  });

  it('refuses a declaration in a file no vitest configuration could run', () => {
    const out = judgeDeclarations({
      files: [{ path: 'packages/runner/src/lib.rs', source: `// ${MARK} whole-tree` }],
    });
    expect(out.declared).toEqual([]);
    expect(out.refused[0].why).toContain('not a JavaScript test file');
  });

  it('reads a tree that declares nothing as an empty scope, never as a pass', () => {
    const out = judgeDeclarations({ files: [{ path: 'a/b.test.ts', source: 'it()' }] });
    expect(out.tests).toBe(1);
    expect(declarationExit(out)).toBe(2);
  });
});

describe('judging the run', () => {
  const one = ['packages/core/src/pipeline/walks.test.ts'];

  it('passes a declared file that a configuration collected and that ran a case', () => {
    const collected = { 'packages/core/vitest.config.ts': one };
    expect(judgeRun({ declared: one, collected, executed: { [one[0]]: 14 } }).refused).toEqual([]);
  });

  it('refuses a declared file no configuration collected', () => {
    const out = judgeRun({ declared: one, collected: {}, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('no vitest configuration collects it');
  });

  it('refuses a declared file that ran no case, as when every case is skipped', () => {
    const collected = { 'packages/core/vitest.config.ts': one };
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('executed no case');
  });
});
