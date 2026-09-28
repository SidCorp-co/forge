import { describe, expect, it } from 'vitest';
import {
  cwdOf,
  declarationExit,
  declarationsIn,
  ENUMERATES_RE,
  judgeDeclarations,
  judgeRun,
  reachesRoot,
  rootReach,
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

describe('where a path expression resolves', () => {
  // WALKER_PATH sits four directories below the root, in a package two below it.
  const PKG = { cwd: 'packages/core' };
  const at = (expr, opts = PKG, path = WALKER_PATH) =>
    rootReach(path, `const p = ${expr};\n${LIST}(p);`, opts);
  const tpl = (base, tail) => ['`', '$', '{', base, '}', tail, '`'].join('');
  const dirnames = (n, inner) =>
    Array.from({ length: n }).reduce((acc) => `dirname(${acc})`, inner);

  it('reaches the root from four deep with four, and not with three', () => {
    expect(reachesRoot(WALKER_PATH, walker(4), PKG)).toBe(true);
    expect(reachesRoot(WALKER_PATH, walker(3), PKG)).toBe(false);
  });

  it('reads the two spellings the literal counter caught', () => {
    expect(at(`new URL('${'../'.repeat(4)}', import.meta.url)`)).not.toBeNull();
    expect(at(`resolve(import.meta.dirname, '${'../'.repeat(3)}..')`)).not.toBeNull();
  });

  it('reads a climb from the directory the runner stands in', () => {
    expect(at(`join(process.cwd(), ${up(2)})`)).toEqual({
      line: 1,
      text: `join(process.cwd(), ${up(2)})`,
    });
    expect(at(`resolve('${'../'.repeat(1)}..')`)).not.toBeNull();
    expect(at(`join(process.cwd(), ${up(1)})`)).toBeNull();
    expect(at('process.cwd()')).toBeNull();
  });

  it('reads a chain of dirname from the directory and from the file', () => {
    expect(at(dirnames(4, 'import.meta.dirname'))).not.toBeNull();
    expect(at(dirnames(3, 'import.meta.dirname'))).toBeNull();
    expect(at(dirnames(5, 'fileURLToPath(import.meta.url)'))).not.toBeNull();
    expect(at(dirnames(4, '__filename'))).toBeNull();
  });

  it('follows a climb split across bindings, a template and a +', () => {
    const split = [
      'const here = dirname(fileURLToPath(import.meta.url));',
      `const pkg = join(here, ${up(2)});`,
      'const root = dirname(dirname(pkg));',
      `${LIST}(root);`,
    ].join('\n');
    expect(rootReach(WALKER_PATH, split, PKG)?.line).toBe(3);
    expect(at(tpl('import.meta.dirname', '/../../../..'))).not.toBeNull();
    expect(at(`__dirname + '/../../../..'`)).not.toBeNull();
    expect(at(tpl('import.meta.dirname', '/../..'))).toBeNull();
  });

  it('takes a base it cannot read as the file’s own directory, only where the text climbs', () => {
    expect(at(`new URL('${'../'.repeat(4)}', discovered())`)).not.toBeNull();
    expect(at(tpl('discovered()', '/../../../..'))).not.toBeNull();
    expect(at(`join(discovered(), ${up(4)})`)).not.toBeNull();
    expect(at(tpl('discovered()', '/fixtures'))).toBeNull();
    expect(at(`new URL('${'../'.repeat(4)}', 'https://example.com/a/b/c/d/')`)).toBeNull();
    expect(at(`resolve('/tmp', ${up(1)})`)).toBeNull();
  });

  it('stands a test the root package holds at the root, so its bare cwd is the root', () => {
    expect(at('process.cwd()', { cwd: '.' }, 'scripts/lib/walks.test.mjs')).not.toBeNull();
  });

  it('reaches the root through git itself', () => {
    expect(reachesRoot(WALKER_PATH, TOPLEVEL, PKG)).toBe(true);
  });

  it('knows a listing call from a single read', () => {
    expect(ENUMERATES_RE.test(`${LIST}(dir)`)).toBe(true);
    expect(ENUMERATES_RE.test(LS_FILES)).toBe(true);
    expect(ENUMERATES_RE.test('readFileSync(path)')).toBe(false);
  });

  it('stands a test in the deepest package directory that holds it', () => {
    const dirs = ['.', 'packages/core', 'packages/core-extra'];
    expect(cwdOf(WALKER_PATH, dirs)).toBe('packages/core');
    expect(cwdOf('packages/core-extra/x.test.ts', dirs)).toBe('packages/core-extra');
    expect(cwdOf('scripts/lib/x.test.mjs', dirs)).toBe('.');
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
    expect(out.refused[0].why).toContain(`line 2 builds \`join(import.meta.dirname, ${up(4)})\``);
    expect(declarationExit(out)).toBe(1);
  });

  it('resolves process.cwd() in the package the test sits in', () => {
    const source = `const ROOT = join(process.cwd(), ${up(2)});\n${LIST}(ROOT);`;
    const files = [{ path: WALKER_PATH, source }];
    expect(judgeDeclarations({ files, packageDirs: ['.', 'packages/core'] }).refused).toHaveLength(
      1,
    );
    expect(judgeDeclarations({ files, packageDirs: ['.', 'packages/core/src'] }).refused).toEqual(
      [],
    );
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

  it('names a declared file that failed to load as a load failure, carrying the error', () => {
    const collected = { 'packages/core/vitest.config.ts': one };
    const loadErrors = { [one[0]]: "Cannot find module './gone.js'" };
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 }, loadErrors });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].why).toBe(
      "failed to load, so none of its cases ran: Cannot find module './gone.js' — fix what it imports or evaluates at load; the declaration stays",
    );
  });
});
