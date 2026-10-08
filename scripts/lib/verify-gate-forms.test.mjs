// @gate-input whole-tree — its fixtures are git repositories, and the code it exercises lists a checkout whole.
// Every form `verify` takes a check in — the whole gate, `--entry`, `--window`, `--all`, and CI —
// on a clean tree with the memo on and an empty store (ISS-1180: `--entry` and `--window` ran
// comment-budget's `--changed` form, which asks git, against a declaration that said it did not).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INPUTS } from './check-inputs.mjs';
import { listEntries } from './verify-memo.mjs';
import { Memo } from './verify-memo-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RATCHET = join(HERE, 'debt-ratchet.mjs');
const VERIFY = readFileSync(join(HERE, '..', 'verify.mjs'), 'utf8');

/** Every check `verify.mjs` declares, with the command of its scoped form where it has one. */
function formsOf(source) {
  const table = source.slice(source.indexOf('const CHECKS = ['), source.indexOf('\n];\n'));
  return table
    .split(/\n {2}\{\n/)
    .map((chunk) => ({
      label: /label: '([^']+)'/.exec(chunk)?.[1],
      scoped: /scoped: \{\s*cmd: (\[[^\]]*\])/.exec(chunk)?.[1],
    }))
    .filter((c) => c.label)
    .map((c) => ({
      label: c.label,
      scoped: c.scoped ? JSON.parse(c.scoped.replaceAll("'", '"')) : null,
    }));
}

/** The checks whose scoped form asks git for the diff and whose declaration does not say so. */
function scopedWithoutGit(forms, inputs) {
  return forms.filter((f) => f.scoped && !inputs[f.label]?.git).map((f) => f.label);
}

describe('the forms verify takes a check in', () => {
  it('reads the scoped form of every check out of verify.mjs', () => {
    const forms = formsOf(VERIFY);
    expect(forms.length).toBeGreaterThan(20);
    expect(forms.filter((f) => f.scoped).map((f) => f.label)).toContain('comment-budget');
  });

  it('declares git for every check whose scoped form is a diff against the base', () => {
    expect(scopedWithoutGit(formsOf(VERIFY), INPUTS)).toEqual([]);
  });

  it('names the check whose declaration lost its git', () => {
    const lost = { ...INPUTS, 'comment-budget': { ...INPUTS['comment-budget'], git: false } };
    expect(scopedWithoutGit(formsOf(VERIFY), lost)).toEqual(['comment-budget']);
  });
});

const CHECKER = `
import { changedFiles } from ${JSON.stringify(RATCHET)};
import { readdirSync, readFileSync } from 'node:fs';
let n;
if (process.argv.includes('--changed')) {
  const r = changedFiles(process.cwd());
  if (r.error) { console.error(r.error); process.exit(2); }
  n = r.files.size;
} else {
  n = readdirSync('src').filter((f) => !readFileSync('src/' + f, 'utf8').includes('BAD')).length;
}
console.log('comment-budget: ' + n + ' file(s) scanned');
`;

describe('the whole and the scoped form of a check that asks git, each through the memo from an empty store', () => {
  let root;
  let dir;
  const sh = (...argv) => spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' });
  const whole = { label: 'comment-budget', cmd: ['node', 'check.mjs', '--all'] };
  const scoped = { label: 'comment-budget', cmd: ['node', 'check.mjs', '--changed'] };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verify-forms-'));
    dir = `${root}-store`;
    sh('git', 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.txt'), 'alpha');
    writeFileSync(join(root, 'check.mjs'), CHECKER);
    sh('git', 'add', '-A');
    sh('git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    sh('git', 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sh('git', 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** One check run as verify runs it: plan, spawn with the planned environment, settle. */
  const take = (check, { args = [], declaration = INPUTS['comment-budget'], ci = false } = {}) => {
    const env = { PATH: process.env.PATH, VERIFY_MEMO_DIR: dir, ...(ci ? { CI: 'true' } : {}) };
    const memo = new Memo({
      root,
      args,
      env,
      baseRef: 'origin/main',
      declarations: { 'comment-budget': declaration },
    });
    const plan = memo.plan(check);
    if (plan.kind === 'hit') return { memo, plan, verdict: { code: 0 }, out: plan.entry.out };
    const r = spawnSync(check.cmd[0], check.cmd.slice(1), {
      cwd: root,
      encoding: 'utf8',
      env: plan.env ?? env,
    });
    const out = `${r.stdout}${r.stderr}`;
    return { memo, plan, out, verdict: memo.settle(plan, r.status, out, { code: r.status, out }) };
  };

  it.each([
    ['the whole gate', whole],
    ['--entry', scoped],
    ['--window', scoped],
  ])('passes %s, files its verdict, and serves it from the store the second time', (_, check) => {
    const first = take(check);
    expect(first.plan.kind).toBe('miss');
    expect(first.verdict.code).toBe(0);
    expect(first.memo.filed).toEqual(['comment-budget']);
    const second = take(check);
    expect(second.plan.kind).toBe('hit');
    expect(second.out).toBe(first.out);
  });

  it('refuses the scoped form by name, with exit 2, once its declaration says it asks no git', () => {
    const declaration = { ...INPUTS['comment-budget'], git: false };
    const planted = take(scoped, { declaration });
    expect(planted.verdict.code).toBe(2);
    expect(planted.verdict.out).toContain('comment-budget memo refused');
    expect(planted.verdict.out).toContain('ran `git diff`, but its declaration has no `git`');
    expect(listEntries(dir)).toHaveLength(0);
  });

  it('goes red through the scoped form when the change it judges is red, and files nothing', () => {
    writeFileSync(join(root, 'check.mjs'), `${CHECKER}\nprocess.exit(1);\n`);
    const red = take(scoped);
    expect(red.verdict.code).toBe(1);
    expect(red.memo.filed).toEqual([]);
  });

  it.each([
    ['--all', { args: ['--all'] }],
    ['CI', { ci: true }],
  ])('neither reads nor writes the store under %s', (_, options) => {
    take(whole);
    const bypassed = take(whole, options);
    expect(bypassed.plan.kind).toBe('bypass');
    expect(bypassed.memo.served).toEqual([]);
    expect(listEntries(dir)).toHaveLength(1);
  });
});
