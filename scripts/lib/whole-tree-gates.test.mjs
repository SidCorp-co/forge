import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  coversRoot,
  declarationExit,
  declarationsIn,
  fsListing,
  guardVerdict,
  judgeConfigs,
  judgeDeclarations,
  judgeRun,
  subprocessListing,
  suiteMessage,
} from './whole-tree-gates.mjs';

const MARK = `@gate-${'input'}`;
const declared = (value, body = 'it();') => [`/**`, ` * ${MARK} ${value}`, ` */`, body].join('\n');
const WALKER_PATH = 'packages/core/src/pipeline/walks.test.ts';

const ROOT = '/repo';
const CORE = '/repo/packages/core';

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

describe('which listed directory covers the root', () => {
  it('is the root itself or a directory above it', () => {
    expect(coversRoot(ROOT, ROOT)).toBe(true);
    expect(coversRoot(ROOT, '/')).toBe(true);
    expect(coversRoot(`${ROOT}/a/b`, ROOT)).toBe(true);
  });

  it('is never a directory inside the root, nor a sibling sharing its prefix', () => {
    expect(coversRoot(ROOT, `${ROOT}/docs`)).toBe(false);
    expect(coversRoot(ROOT, '/repo-other')).toBe(false);
    expect(coversRoot(ROOT, '/rep')).toBe(false);
  });
});

describe('what a node:fs call lists', () => {
  it('resolves a relative path against the directory the test runs in', () => {
    expect(fsListing('readdirSync', ['../..'], CORE)).toEqual([ROOT]);
    expect(fsListing('readdirSync', ['src'], CORE)).toEqual([`${CORE}/src`]);
  });

  it('reads a file URL, trailing slash and all, and a Buffer', () => {
    expect(fsListing('readdirSync', [pathToFileURL(`${ROOT}/`)], CORE)).toEqual([ROOT]);
    expect(fsListing('opendirSync', [Buffer.from('../..')], CORE)).toEqual([ROOT]);
    expect(fsListing('readdir', [new URL('https://example.com/')], CORE)).toEqual([]);
  });

  it('lists a glob from its cwd and the pattern’s segments before the first magic one', () => {
    expect(fsListing('globSync', ['**/*.md', { cwd: ROOT }], CORE)).toEqual([ROOT]);
    expect(fsListing('glob', ['../../docs/**/*.md'], CORE)).toEqual([`${ROOT}/docs`]);
    expect(fsListing('globSync', [['src/*.ts', '../../*']], CORE)).toEqual([`${CORE}/src`, ROOT]);
    expect(fsListing('globSync', [`${ROOT}/**`], CORE)).toEqual([ROOT]);
  });
});

describe('what a child process lists', () => {
  const run = (command, args = [], opts = {}) =>
    subprocessListing({ command, args, cwd: CORE, root: ROOT, ...opts }).map((e) => e.dir);

  it('reads git’s listing commands where they run, and the top-level pathspecs', () => {
    expect(run('git', ['ls-files'], { cwd: ROOT })).toEqual([ROOT]);
    expect(run('git', ['-C', '../..', 'ls-files'])).toEqual([ROOT]);
    expect(run('git', ['ls-files', ':/'])).toEqual([ROOT]);
    expect(run('git', ['ls-tree', '-r', '--full-tree', 'HEAD'])).toEqual([ROOT]);
    expect(run('git', ['grep', 'someKey'])).toEqual([CORE]);
    expect(run('git', ['log', '-1'])).toEqual([]);
  });

  it('reads a shell string, a cd moving the rest', () => {
    expect(run('git ls-files', [], { shell: true })).toEqual([CORE]);
    expect(run('cd ../.. && find . -name "*.md"', [], { shell: true })).toEqual([ROOT]);
    expect(run('sh', ['-c', 'cd ../.. && git ls-files'])).toEqual([ROOT]);
    expect(run('echo hi | cat', [], { shell: true })).toEqual([]);
  });

  it('reads find, ls, rg and a recursive grep, each defaulting to where it runs', () => {
    expect(run('find', ['../..', '-name', 'x'])).toEqual([ROOT]);
    expect(run('find')).toEqual([CORE]);
    expect(run('ls', ['-la', '../..'])).toEqual([ROOT]);
    expect(run('rg', ['--files', '../..'])).toEqual([ROOT]);
    expect(run('rg', ['pattern'])).toEqual([CORE]);
    expect(run('grep', ['-rn', 'x', '../..'])).toEqual([ROOT]);
    expect(run('grep', ['x', 'file.txt'])).toEqual([]);
  });

  it('reads past find’s leading options to its starting points', () => {
    expect(run('find', ['-L', '../..', '-name', 'x'])).toEqual([ROOT]);
    expect(run('find', ['--', '../..', '-name', 'x'])).toEqual([ROOT]);
    expect(run('find', ['-D', 'stat', '-O2', '../..'])).toEqual([ROOT]);
  });

  it('reads the command a launcher runs, and not the launcher', () => {
    expect(run('env', ['FOO=1', 'python3', 'walk.py'], { cwd: ROOT })).toEqual([ROOT]);
    expect(run('env', ['FOO=1', 'python3', 'walk.py'])).toEqual([]);
    expect(run('timeout', ['5', 'find', '../..'])).toEqual([ROOT]);
    expect(run('cd ../.. && env -i ls', [], { shell: true })).toEqual([ROOT]);
    expect(run('env', ['FOO=1', 'cat', 'x'], { cwd: ROOT })).toEqual([]);
  });

  it('counts a program it cannot see into as listing the root where it may reach it', () => {
    const climbs = "import os; os.listdir('../..')";
    const [entry] = subprocessListing({
      command: 'python3',
      args: ['-c', climbs],
      cwd: CORE,
      root: ROOT,
    });
    expect(entry).toEqual({
      dir: ROOT,
      via: '`python3` (a program the guard cannot see into, so counted as listing the root)',
      unseen: true,
    });
    expect(run('python3', ['walk.py'], { cwd: ROOT })).toEqual([ROOT]);
    expect(run('python3', ['-c', `os.listdir('${ROOT}')`])).toEqual([ROOT]);
    expect(run('cd ../.. && ./walk.sh', [], { shell: true })).toEqual([ROOT]);
    expect(run('python3', ['-c', climbs], { shell: true })).toEqual([ROOT]);
  });

  it('reads the script an unseen program runs for a climb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-script-'));
    writeFileSync(join(dir, 'up.sh'), 'ls ../../..\n');
    writeFileSync(join(dir, 'flat.sh'), 'git rev-parse HEAD\n');
    const at = (script) =>
      subprocessListing({ command: 'bash', args: [script], cwd: dir, root: ROOT }).map(
        (e) => e.dir,
      );
    expect(at('up.sh')).toEqual([ROOT]);
    expect(at('flat.sh')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an unseen program below the root that is handed nothing reaching it', () => {
    expect(run('python3', ['-c', 'print(1)'])).toEqual([]);
    expect(run('python3', [`${ROOT}/packages/core/walk.py`])).toEqual([]);
    expect(run('sh', ['-c', 'ulimit -f "$1" && shift && exec git "$@"', 'sh', '9'])).toEqual([]);
  });

  it('leaves Node, which the preload watches from inside, and a program that reads only files', () => {
    expect(run('node', ['scripts/x.mjs'], { cwd: ROOT })).toEqual([]);
    expect(run('pnpm', ['exec', 'vitest'], { cwd: ROOT })).toEqual([]);
    expect(run('cat package.json | wc -l', [], { shell: true, cwd: ROOT })).toEqual([]);
  });
});

describe('what a run owes after it listed the root', () => {
  const hit = (dir, at = 'packages/core/src/pipeline/walks.fixture.ts:5') => ({
    dir,
    via: 'readdirSync()',
    at,
  });

  it('refuses an undeclared file, naming the file, the listing, its call site and the line to add', () => {
    const why = guardVerdict({ file: WALKER_PATH, source: 'it();', hits: [hit(ROOT)], root: ROOT });
    expect(why).toBe(
      `whole-tree-gates: ${WALKER_PATH} readdirSync() listed the repository root (called at packages/core/src/pipeline/walks.fixture.ts:5), ` +
        'so its input is the whole tree and not the paths its job is selected by, and a change outside them skips it — add a line ' +
        `\`// ${MARK} whole-tree\` (or \` * ${MARK} whole-tree\` in its opening docblock) so it runs on every change`,
    );
  });

  it('names a directory above the root as that, and counts past three', () => {
    const hits = [hit('/'), hit(ROOT), hit(ROOT), hit(ROOT), hit(ROOT, null)];
    const why = guardVerdict({ file: WALKER_PATH, source: '', hits, root: ROOT });
    expect(why).toContain('readdirSync() listed /, above the repository root');
    expect(why).toContain(', and 2 more,');
  });

  it('owes nothing for a declared file, nor for a listing inside the root', () => {
    const source = declared('whole-tree');
    expect(guardVerdict({ file: WALKER_PATH, source, hits: [hit(ROOT)], root: ROOT })).toBeNull();
    const inside = [hit(`${ROOT}/packages/core`)];
    expect(guardVerdict({ file: WALKER_PATH, source: '', hits: inside, root: ROOT })).toBeNull();
  });

  it('does not take a declaration with a wrong value as a declaration', () => {
    const source = declared('wholetree');
    expect(guardVerdict({ file: WALKER_PATH, source, hits: [hit(ROOT)], root: ROOT })).toContain(
      'listed the repository root',
    );
  });
});

describe('the guard installed in this very run', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const state = globalThis[Symbol.for('forge.whole-tree-guard')];
  const covering = () => state.hits.filter((h) => coversRoot(REPO, h.dir));
  // Every case here lists the root on purpose, so each clears what it recorded before `afterAll`
  // would refuse this undeclared file for it.
  afterEach(() => {
    state.hits = [];
  });

  it('is installed by the configuration that collects this file', () => {
    expect(state?.installed).toBe(true);
  });

  it('sees a named node:fs import list the root, with this file as the call site', () => {
    readdirSync(join(REPO, 'packages', '..'));
    expect(covering()).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: 'readdirSync()',
        at: expect.stringMatching(/^scripts\/lib\/whole-tree-gates\.test\.mjs:\d+$/),
      }),
    ]);
  });

  it('sees node:fs/promises and a git subprocess list it', async () => {
    await readdir(REPO);
    execFileSync('git', ['ls-files', '--', 'package.json'], { cwd: REPO });
    expect(covering().map((h) => h.via)).toEqual([
      'readdir()',
      'execFileSync() running git ls-files',
    ]);
  });

  it('keeps promisify(execFile) resolving to stdout and stderr, and watches it too', async () => {
    const out = await promisify(execFile)('git', ['ls-files', '--', 'package.json'], { cwd: REPO });
    expect(out.stdout.trim()).toBe('package.json');
    expect(out.stderr).toBe('');
    expect(covering().map((h) => h.via)).toEqual(['execFile() running git ls-files']);
  });

  it('sees a Node child list it, a call handing its own env included', () => {
    const script = `require('node:fs').readdirSync(${JSON.stringify(REPO)})`;
    spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH } });
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        dir: REPO,
        via: expect.stringMatching(/^readdirSync\(\) in child process \d+$/),
        at: null,
      }),
    ]);
  });

  it('sees an eval worker list it', async () => {
    const code = `require('node:fs').readdirSync(${JSON.stringify(REPO)});`;
    await new Promise((done, fail) =>
      new Worker(code, { eval: true }).on('exit', done).on('error', fail),
    );
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l).via)).toEqual([
      expect.stringMatching(/^readdirSync\(\) in worker \d+ of process \d+$/),
    ]);
  });

  it('sees a worker thread list it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whole-tree-worker-'));
    const file = join(dir, 'lists.mjs');
    writeFileSync(
      file,
      `import { readdirSync } from 'node:fs'; readdirSync(${JSON.stringify(REPO)});`,
    );
    await new Promise((done, fail) => new Worker(file).on('exit', done).on('error', fail));
    rmSync(dir, { recursive: true, force: true });
    const logged = readFileSync(state.log, 'utf8').trim().split('\n').filter(Boolean);
    writeFileSync(state.log, '');
    expect(logged.map((l) => JSON.parse(l).dir)).toEqual([REPO]);
  });

  it('records nothing covering the root for a listing inside it', () => {
    readdirSync(import.meta.dirname);
    expect(covering()).toEqual([]);
  });
});

describe('a run of a file that lists the root', () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'whole-tree-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const config = `export default { test: { globals: true, include: ['*.test.mjs'], setupFiles: [${JSON.stringify(join(REPO, 'scripts/lib/whole-tree-guard.mjs'))}] } };`;
  writeFileSync(join(dir, 'vitest.config.mjs'), config);
  const body = [
    "import { readdirSync } from 'node:fs';",
    "it('lists the root', () => { expect(readdirSync(process.env.WT_ROOT)).toContain('pnpm-workspace.yaml'); });",
  ];
  // The vitest this suite runs under, started on a scratch root that holds nothing but the file.
  const vitest = (file) =>
    spawnSync(
      process.execPath,
      [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', dir, file],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, WT_ROOT: REPO, FORCE_COLOR: '0' } },
    );

  it('fails an undeclared one in afterAll, naming the file, the listing and the line to add', () => {
    writeFileSync(join(dir, 'plain.test.mjs'), body.join('\n'));
    const r = vitest('plain.test.mjs');
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(
      /plain\.test\.mjs readdirSync\(\) listed the repository root \(called at [^)]*plain\.test\.mjs:2\)[^\n]*add a line `\/\/ @gate-input whole-tree`/,
    );
  }, 60_000);

  it('passes the same file once it carries the declaration', () => {
    writeFileSync(join(dir, 'marked.test.mjs'), [`// ${MARK} whole-tree`, ...body].join('\n'));
    const r = vitest('marked.test.mjs');
    expect(`${r.stdout}${r.stderr}`).not.toContain('listed the repository root');
    expect(r.status).toBe(0);
  }, 60_000);
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

describe('judging the vitest configurations', () => {
  it('passes one that names the guard by its path from the config', () => {
    const source =
      "test: { setupFiles: ['./vitest.setup.ts', '../../scripts/lib/whole-tree-guard.mjs'] },";
    expect(judgeConfigs([{ path: 'packages/core/vitest.config.ts', source }])).toEqual([]);
  });

  it('refuses one that does not, naming the path to add', () => {
    const configs = [
      { path: 'packages/extra/vitest.config.ts', source: "setupFiles: ['./setup.ts']," },
      {
        path: 'vitest.config.ts',
        source: "setupFiles: ['../../scripts/lib/whole-tree-guard.mjs'],",
      },
    ];
    expect(judgeConfigs(configs)).toEqual([
      {
        path: 'packages/extra/vitest.config.ts',
        why: "does not install the guard that refuses an undeclared root walk — add '../../scripts/lib/whole-tree-guard.mjs' to its `test.setupFiles`",
      },
      {
        path: 'vitest.config.ts',
        why: "does not install the guard that refuses an undeclared root walk — add 'scripts/lib/whole-tree-guard.mjs' to its `test.setupFiles`",
      },
    ]);
  });

  it('refuses the path standing only in a comment, or outside setupFiles', () => {
    const guard = "'../../scripts/lib/whole-tree-guard.mjs'";
    const sources = [
      `setupFiles: ['./setup.ts'], // ${guard}`,
      `setupFiles: [\n  './setup.ts',\n  // ${guard},\n],`,
      `setupFiles: [], /* ${guard} */`,
      `const unused = ${guard};\nsetupFiles: ['./setup.ts'],`,
    ];
    const configs = sources.map((source) => ({ path: 'packages/core/vitest.config.ts', source }));
    expect(judgeConfigs(configs)).toHaveLength(4);
  });

  it('reads only test.setupFiles, never a top-level or a nested one', () => {
    const guard = "'../../scripts/lib/whole-tree-guard.mjs'";
    const path = 'packages/core/vitest.config.ts';
    const refused = [
      `export default defineConfig({ setupFiles: [${guard}], test: { include: ['x'] } });`,
      `export default { test: { poolOptions: { forks: { setupFiles: [${guard}] } } } };`,
    ];
    expect(judgeConfigs(refused.map((source) => ({ path, source })))).toHaveLength(2);
    const source = `export default { test: { typecheck: { enabled: true }, setupFiles: [${guard}] } };`;
    expect(judgeConfigs([{ path, source }])).toEqual([]);
  });
});

describe('the message a failed suite is refused with', () => {
  it('carries a header ending in a colon on to the error it introduces', () => {
    const message =
      'Transform failed with 1 error:\n/x/a.test.ts:4:0: ERROR: Unexpected end of file\n  at y';
    expect(suiteMessage(message)).toBe(
      'Transform failed with 1 error: /x/a.test.ts:4:0: ERROR: Unexpected end of file',
    );
  });

  it('keeps one line that stands on its own, with the colour codes gone', () => {
    expect(suiteMessage("\u001b[31mCannot find module './gone.js'\u001b[39m\nstack")).toBe(
      "Cannot find module './gone.js'",
    );
    expect(suiteMessage('')).toBeNull();
    expect(suiteMessage(undefined)).toBeNull();
  });
});

describe('judging the run', () => {
  const one = ['packages/core/src/pipeline/walks.test.ts'];
  const collected = { 'packages/core/vitest.config.ts': one };

  it('passes a declared file that a configuration collected and that ran a case', () => {
    expect(judgeRun({ declared: one, collected, executed: { [one[0]]: 14 } }).refused).toEqual([]);
  });

  it('refuses a declared file no configuration collected', () => {
    const out = judgeRun({ declared: one, collected: {}, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('no vitest configuration collects it');
  });

  it('refuses a declared file that ran no case, as when every case is skipped', () => {
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 } });
    expect(out.refused[0].why).toContain('executed no case');
  });

  it('names a suite that failed before any case ran by its error, never as a skip', () => {
    const suiteErrors = { [one[0]]: 'Error: the tree could not be listed' };
    const out = judgeRun({ declared: one, collected, executed: { [one[0]]: 0 }, suiteErrors });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].why).toBe(
      'failed before any of its cases ran: Error: the tree could not be listed — fix what it imports, evaluates at load or throws in a hook; the declaration stays',
    );
  });
});
