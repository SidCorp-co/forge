import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-migration-order.mjs');
const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function journal(...entries) {
  return JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: entries.map(([idx, when, tag]) => ({
      idx,
      version: '7',
      when,
      tag,
      breakpoints: true,
    })),
  });
}

function writeJournal(repo, text) {
  mkdirSync(join(repo, dirname(JOURNAL)), { recursive: true });
  writeFileSync(join(repo, JOURNAL), text);
}

/** A bare `origin` with a `main` holding `mainJournal`, and a clone pointed at it. */
function world(mainJournal) {
  const box = mkdtempSync(join(tmpdir(), 'migration-order-'));
  made.push(box);
  const origin = join(box, 'origin.git');
  git(box, 'init', '--bare', '--initial-branch=main', origin);

  const seed = join(box, 'seed');
  git(box, 'clone', origin, seed);
  git(seed, 'config', 'user.email', 'check@example.invalid');
  git(seed, 'config', 'user.name', 'check');
  writeJournal(seed, mainJournal);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'main');
  git(seed, 'push', 'origin', 'main');
  return { box, origin, seed };
}

/** Push a branch onto `origin` carrying `text` as its journal. */
function pushBranch(world_, name, text) {
  const work = join(world_.box, `w-${name}`);
  git(world_.box, 'clone', '-b', 'main', world_.origin, work);
  git(work, 'config', 'user.email', 'check@example.invalid');
  git(work, 'config', 'user.name', 'check');
  git(work, 'checkout', '-b', name);
  writeJournal(work, text);
  // A branch that carries the same journal as main still has to be a commit, or there is no
  // branch to read — and a branch whose only change is elsewhere is exactly the ordinary case.
  writeFileSync(join(work, 'what-this-branch-changes.txt'), name);
  git(work, 'add', '-A');
  git(work, 'commit', '-m', name);
  git(work, 'push', 'origin', name);
  return work;
}

function run(cwd) {
  const r = spawnSync('node', [CHECKER], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * The file in `repo`'s own object store backing `rev`, asserted to be there before it is removed.
 *
 * A local clone of these worlds hardlinks the loose objects it finds, so removing this name costs
 * `repo` the object and costs `origin` nothing. The assertion is the test's own guard: were git
 * ever to hand these back packed, the removal would be a no-op and the run would be judging a
 * store nothing had been taken from.
 */
function dropObject(repo, rev) {
  const sha = git(repo, 'rev-parse', rev);
  const path = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  expect(existsSync(path)).toBe(true);
  rmSync(path);
}

describe('check-migration-order, against real repositories', () => {
  it('passes a tree that lands no migration without reaching the remote at all', () => {
    const w = world(journal([288, 1000, '0288_main']));
    const work = pushBranch(w, 'iss-quiet', journal([288, 1000, '0288_main']));
    // Nothing else changed the journal, so this branch is a real no-migration branch. Break the
    // remote outright: a pass here is a pass that never needed it.
    git(work, 'remote', 'set-url', 'origin', join(w.box, 'no-such-remote.git'));
    git(work, 'commit', '--allow-empty', '-m', 'work that is not a migration');

    const { code, out } = run(work);
    expect(out).toContain('adds no migration');
    expect(out).toContain('the open set was not read');
    expect(code).toBe(0);
  });

  it('refuses a landing it cannot measure, naming the migrations, rather than passing', () => {
    const w = world(journal([288, 1000, '0288_main']));
    const work = pushBranch(
      w,
      'iss-blind',
      journal([288, 1000, '0288_main'], [289, 2000, '0289_x']),
    );
    git(work, 'remote', 'set-url', 'origin', join(w.box, 'no-such-remote.git'));

    const { code, out } = run(work);
    expect(code).toBe(2);
    expect(out).toContain('0289_x');
    expect(out).toContain('could not be enumerated');
  });

  it('refuses two pushed branches holding one `when`, naming both and the number', () => {
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-b', journal([288, 1000, '0288_main'], [290, 2000, '0290_b']));
    const work = pushBranch(w, 'iss-a', journal([288, 1000, '0288_main'], [289, 2000, '0289_a']));
    git(work, 'fetch', 'origin');

    const { code, out } = run(work);
    expect(code).toBe(1);
    expect(out).toContain('duplicate-when');
    expect(out).toContain('iss-a');
    expect(out).toContain('origin/iss-b');
    expect(out).toContain('2000');
  });

  it('refuses an entry that does not clear the floor main already holds', () => {
    const w = world(journal([288, 1000, '0288_main'], [290, 3000, '0290_main']));
    const work = pushBranch(
      w,
      'iss-late',
      journal([288, 1000, '0288_main'], [290, 3000, '0290_main'], [291, 2000, '0291_late']),
    );

    const { code, out } = run(work);
    expect(code).toBe(1);
    expect(out).toContain('below-floor');
    expect(out).toContain('0291_late');
    expect(out).toContain('3000');
  });

  it('passes an orderable set and prints the order and the next free number', () => {
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-first', journal([288, 1000, '0288_main'], [289, 2000, '0289_first']));
    const work = pushBranch(
      w,
      'iss-second',
      journal([288, 1000, '0288_main'], [290, 3000, '0290_second']),
    );

    const { code, out } = run(work);
    expect(code).toBe(0);
    expect(out).toContain('Merge order');
    expect(out.indexOf('origin/iss-first')).toBeLessThan(out.indexOf('iss-second'));
    expect(out).toContain(`when ${3000 + 86_400_000}`);
    expect(out).toContain('index 291');
  });

  it('names, from a tree that IS main, the branch the last merge stranded', () => {
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-stranded', journal([288, 1000, '0288_main'], [289, 2000, '0289_stranded']));
    // main then lands a higher migration of its own: the open branch is now below the floor.
    writeJournal(w.seed, journal([288, 1000, '0288_main'], [290, 3000, '0290_landed']));
    git(w.seed, 'commit', '-am', 'a migration that overtakes the open branch');
    git(w.seed, 'push', 'origin', 'main');
    git(w.seed, 'fetch', 'origin');

    const { code, out } = run(w.seed);
    expect(code).toBe(0);
    expect(out).toContain('Already below the floor');
    expect(out).toContain('origin/iss-stranded');
    expect(out).toContain('0289_stranded');
  });

  it('exits 2 rather than 0 when there is no main to read a floor from', () => {
    const box = mkdtempSync(join(tmpdir(), 'migration-order-'));
    made.push(box);
    git(box, 'init', '--initial-branch=work', box);
    git(box, 'config', 'user.email', 'check@example.invalid');
    git(box, 'config', 'user.name', 'check');
    writeJournal(box, journal([1, 1000, '0001_x']));
    git(box, 'add', '-A');
    git(box, 'commit', '-m', 'no main anywhere');

    const { code, out } = run(box);
    expect(code).toBe(2);
    expect(out).toContain('origin/main does not resolve');
  });
});

describe('check-migration-order, on the checkouts CI actually produces', () => {
  it('does not read its own PR branch as a sibling from a detached merge ref', () => {
    // `actions/checkout` leaves HEAD detached on refs/pull/N/merge, where `--abbrev-ref HEAD`
    // answers `HEAD`. Without the three readings of "this is us", the PR's own branch is read as
    // a sibling holding every one of this tree's migrations, and every migration-bearing PR is
    // refused against itself.
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-pr', journal([288, 1000, '0288_main'], [289, 2000, '0289_pr']));

    const ci = join(w.box, 'ci');
    git(w.box, 'clone', '-b', 'main', w.origin, ci);
    git(ci, 'config', 'user.email', 'check@example.invalid');
    git(ci, 'config', 'user.name', 'check');
    git(ci, 'fetch', 'origin');
    git(ci, 'merge', '--no-ff', '--no-edit', 'origin/iss-pr');
    const merged = git(ci, 'rev-parse', 'HEAD');
    git(ci, 'checkout', '--detach', merged);

    expect(git(ci, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    const { code, out } = run(ci);
    expect(out).not.toContain('duplicate-when');
    expect(out).not.toContain('duplicate-idx');
    expect(code).toBe(0);
  });

  it('measures against the main the fetch found, not the one cached before it', () => {
    // The candidate was cut when the floor was 1000 and took 2000. main has since landed 3000.
    // The candidate never fetched, so everything derived from main before the check's own fetch
    // is stale — and a pass on a stale floor is the loss this check exists to refuse.
    const w = world(journal([288, 1000, '0288_main']));
    const work = pushBranch(
      w,
      'iss-behind',
      journal([288, 1000, '0288_main'], [289, 2000, '0289_behind']),
    );
    writeJournal(w.seed, journal([288, 1000, '0288_main'], [290, 3000, '0290_overtook']));
    git(w.seed, 'commit', '-am', 'main overtakes the open branch');
    git(w.seed, 'push', 'origin', 'main');

    expect(git(work, 'rev-parse', 'origin/main')).not.toBe(git(w.seed, 'rev-parse', 'HEAD'));
    const { code, out } = run(work);
    expect(code).toBe(1);
    expect(out).toContain('below-floor');
    expect(out).toContain('0289_behind');
    expect(out).toContain('3000');
  });

  it('refuses a set with a hole in it rather than passing over the branch it cannot read', () => {
    const w = world(journal([288, 1000, '0288_main']));
    const broken = pushBranch(w, 'iss-broken', journal([288, 1000, '0288_main']));
    writeFileSync(join(broken, JOURNAL), '{ this is not json');
    git(broken, 'commit', '-am', 'a journal that will not read');
    git(broken, 'push', 'origin', 'iss-broken');
    const work = pushBranch(w, 'iss-ok', journal([288, 1000, '0288_main'], [289, 2000, '0289_ok']));

    const { code, out } = run(work);
    expect(code).toBe(2);
    expect(out).toContain('origin/iss-broken');
  });

  it('passes over a branch that carries no journal at all, which is an absence and not a hole', () => {
    const w = world(journal([288, 1000, '0288_main']));
    const none = pushBranch(w, 'iss-nojournal', journal([288, 1000, '0288_main']));
    git(none, 'rm', '-r', '--quiet', dirname(JOURNAL));
    git(none, 'commit', '-m', 'a branch with no migrations directory');
    git(none, 'push', 'origin', 'iss-nojournal');
    const work = pushBranch(w, 'iss-ok', journal([288, 1000, '0288_main'], [289, 2000, '0289_ok']));

    const { code, out } = run(work);
    expect(code).toBe(0);
    expect(out).toContain('Merge order');
  });
});

describe('a sibling git cannot read is an unknown, and an unknown is not an absence', () => {
  /** main, a sibling landing 289, and this tree landing 290 — a set with no quarrel in it. */
  function setWithASibling() {
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-sibling', journal([288, 1000, '0288_main'], [289, 2000, '0289_sibling']));
    const work = pushBranch(w, 'iss-ok', journal([288, 1000, '0288_main'], [290, 3000, '0290_ok']));
    return { w, work };
  }

  it('passes that set while every branch in it can be read', () => {
    // Without this, the two refusals below could be produced by a world that was broken to begin
    // with, and neither would be evidence about the object that was removed.
    const { code, out } = run(setWithASibling().work);
    expect(code).toBe(0);
    expect(out).toContain('origin/iss-sibling');
  });

  it('refuses a journal that is in the tree and will not read, rather than reading it as absent', () => {
    const { work } = setWithASibling();
    dropObject(work, `origin/iss-sibling:${JOURNAL}`);

    // The path IS in that branch's tree: `ls-tree` reads the tree object and lists it without
    // touching the blob. So this branch has a journal, and the store cannot produce it.
    expect(git(work, 'ls-tree', '--name-only', 'origin/iss-sibling', '--', JOURNAL)).toBe(JOURNAL);

    // `git cat-file -e` — the probe this replaced — exits non-zero here AND on a path that was
    // never in the tree, so it answered both with one number. Reading that number as absence
    // dropped this branch from the set and printed a merge order over what was left: exit 0, `0
    // open branch(es) read`, on a landing nothing had measured. That is the silent substitution
    // this whole check exists to refuse, reached from inside the check itself.
    const { code, out } = run(work);
    expect(code).toBe(2);
    expect(out).toContain('origin/iss-sibling');
    expect(out).toContain('will not read');
    expect(out).toContain('0290_ok');
    expect(out).not.toContain('Merge order');
  });

  it('refuses a tree it cannot read at all, where absence cannot even be put to the question', () => {
    const { work } = setWithASibling();
    dropObject(work, 'origin/iss-sibling^{tree}');

    const { code, out } = run(work);
    expect(code).toBe(2);
    expect(out).toContain('origin/iss-sibling');
    expect(out).toContain('could not be read');
    expect(out).not.toContain('Merge order');
  });
});
