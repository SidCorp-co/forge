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

/**
 * The whole environment every child of this fixture gets, built up rather than filtered down.
 *
 * cm:guard a fixture inheriting the ambient environment is not hermetic: its subject reads
 * `GITHUB_HEAD_REF` on purpose and its `git` reads `GIT_DIR`, `GIT_WORK_TREE` and a dozen more,
 * so a list of names to DELETE is a list of the ones that have bitten us so far. Only `PATH` and
 * `LC_ALL` are carried — what makes `node` and `git` findable, and what pins git to one language.
 */
const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
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

function run(cwd, extra = {}) {
  const env = { ...SEALED_ENV, ...extra };
  const r = spawnSync('node', [CHECKER], { cwd, encoding: 'utf8', env });
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

  it('exits 2 rather than 0 when no merge target answers, naming every source it read', () => {
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
    expect(out).toContain('no merge target could be derived');
    expect(out).toContain('$GITHUB_BASE_REF');
    expect(out).toContain('refs/remotes/origin/HEAD');
    expect(out).toContain('git remote set-head origin -a');
  });

  it('exits 2 when the merge target is named but resolves to no ref here', () => {
    const w = world(journal([288, 1000, '0288_main']));
    const work = pushBranch(w, 'iss-far', journal([288, 1000, '0288_main'], [289, 2000, '0289_x']));

    const { code, out } = run(work, { GITHUB_BASE_REF: 'release/9' });
    expect(code).toBe(2);
    expect(out).toContain('`release/9`');
    expect(out).toContain('origin/release/9');
    expect(out).toContain('git fetch origin release/9');
  });
});

/**
 * ISS-1384 — a second gated line (`dev`) that merges `main` in and renumbers its own migrations
 * above it. Its branches land on `dev`, so counting them against a `main` tree refused every
 * migration `main` took while `dev` held any of its own: 93 refusals on 2026-10-07, none of them a
 * real collision.
 */
describe('check-migration-order, beside another gated line', () => {
  const CI = '.github/workflows/ci.yml';
  const GATED =
    'name: CI\non:\n  push:\n    branches: [main, dev]\n  pull_request:\n    branches: [main, dev]\n';

  function twoLines({ declareDev }) {
    const w = world(journal([288, 1000, '0288_main']));
    // `dev` and a branch cut from it both hold the number this `main` tree is about to take.
    const devWork = pushBranch(
      w,
      'dev',
      journal([288, 1000, '0288_main'], [289, 2000, '0289_dev']),
    );
    git(devWork, 'checkout', '-b', 'dev-iss-7');
    writeFileSync(join(devWork, 'what-dev-iss-7-changes.txt'), 'x');
    git(devWork, 'add', '-A');
    git(devWork, 'commit', '-m', 'dev-iss-7');
    git(devWork, 'push', 'origin', 'dev-iss-7');
    const work = pushBranch(
      w,
      'iss-main',
      journal([288, 1000, '0288_main'], [289, 2000, '0289_main']),
    );
    mkdirSync(join(work, dirname(CI)), { recursive: true });
    writeFileSync(join(work, CI), declareDev ? GATED : GATED.replaceAll(', dev', ''));
    return { w, work };
  }

  it('sets the other line aside, naming it, and orders this tree first', () => {
    const { work } = twoLines({ declareDev: true });
    const { code, out } = run(work, { GITHUB_BASE_REF: 'main' });
    expect(out).toContain('On another gated line, and not counted against origin/main');
    expect(out).toContain('dev: origin/dev, origin/dev-iss-7');
    expect(out).not.toContain('duplicate-when');
    expect(out).toContain('1. iss-main: 0289_main  <- this tree');
    expect(code).toBe(0);
  });

  it('still counts the same branches where CI gates no such line, which is the set before it', () => {
    const { work } = twoLines({ declareDev: false });
    const { code, out } = run(work, { GITHUB_BASE_REF: 'main' });
    expect(out).toContain('[duplicate-when]');
    expect(out).toContain('origin/dev');
    expect(code).toBe(1);
  });

  it('still refuses a base-line sibling the other line merged in, holding the same number', () => {
    const { w, work } = twoLines({ declareDev: true });
    const sibling = pushBranch(
      w,
      'iss-integrated',
      journal([288, 1000, '0288_main'], [290, 2000, '0290_integrated']),
    );
    // `dev` takes the main-bound branch in for integration, with a merge commit of its own.
    const devWork = join(w.box, 'w-dev');
    git(devWork, 'checkout', 'dev');
    git(devWork, 'fetch', 'origin', 'iss-integrated');
    git(devWork, 'merge', '--no-ff', '-X', 'ours', '-m', 'dev takes iss-integrated', 'FETCH_HEAD');
    git(devWork, 'push', 'origin', 'dev');
    expect(sibling).toBeTruthy();
    const { code, out } = run(work, { GITHUB_BASE_REF: 'main' });
    expect(out).toContain(
      '[duplicate-when] iss-main and origin/iss-integrated both hold when 2000',
    );
    expect(code).toBe(1);
  });

  it('still refuses a sibling on its own line holding the same number', () => {
    const { w, work } = twoLines({ declareDev: true });
    pushBranch(w, 'iss-other', journal([288, 1000, '0288_main'], [290, 2000, '0290_other']));
    const { code, out } = run(work, { GITHUB_BASE_REF: 'main' });
    expect(out).toContain('[duplicate-when] iss-main and origin/iss-other both hold when 2000');
    expect(code).toBe(1);
  });
});

/**
 * The failure the whole issue is about, built rather than argued: `main` lags the branch the work
 * is cut from, so a floor read off `main` clears a `when` the merge target has already spent, and
 * drizzle skips that migration silently and for ever once both land.
 */
describe('check-migration-order, when the merge target is not `main`', () => {
  function divergedWorld() {
    const w = world(journal([288, 1000, '0288_base']));
    // `dev` carries a migration `main` has not taken yet — which is what a promote-model base
    // branch looks like between promotions.
    const devWork = join(w.box, 'w-dev');
    git(w.box, 'clone', '-b', 'main', w.origin, devWork);
    git(devWork, 'config', 'user.email', 'check@example.invalid');
    git(devWork, 'config', 'user.name', 'check');
    git(devWork, 'checkout', '-b', 'dev');
    writeJournal(devWork, journal([288, 1000, '0288_base'], [290, 3000, '0290_on_dev']));
    git(devWork, 'add', '-A');
    git(devWork, 'commit', '-m', 'dev');
    git(devWork, 'push', 'origin', 'dev');

    // The work, cut from `dev`, taking a number that clears `main`'s floor and not `dev`'s.
    const work = join(w.box, 'w-iss');
    git(w.box, 'clone', '-b', 'dev', w.origin, work);
    git(work, 'config', 'user.email', 'check@example.invalid');
    git(work, 'config', 'user.name', 'check');
    git(work, 'checkout', '-b', 'iss-late');
    writeJournal(
      work,
      journal([288, 1000, '0288_base'], [290, 3000, '0290_on_dev'], [289, 2000, '0289_late']),
    );
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'iss-late');
    git(work, 'push', 'origin', 'iss-late');
    return { w, work };
  }

  it('refuses the entry a `main`-derived floor would have let through', () => {
    const { work } = divergedWorld();
    const { code, out } = run(work, { GITHUB_BASE_REF: 'dev' });
    expect(code).toBe(1);
    expect(out).toContain('0289_late');
    expect(out).toContain('does not clear origin/dev');
    expect(out).toContain('3000');
  });

  it('takes its floor and its next-free number from `dev`, not from `main`', () => {
    const { work } = divergedWorld();
    const { out } = run(work, { GITHUB_BASE_REF: 'dev' });
    expect(out).toContain('origin/dev floor: 3000');
    expect(out).toContain('merge target dev, from GITHUB_BASE_REF');
    expect(out).toContain(`when ${3000 + 86_400_000}`);
  });

  it('is the same tree `main` as the base lets through, which is the defect', () => {
    const { work } = divergedWorld();
    const { code, out } = run(work, { GITHUB_BASE_REF: 'main' });
    expect(code).toBe(0);
    expect(out).toContain('origin/main floor: 1000');
    expect(out).not.toContain('below-floor');
  });
});

describe('check-migration-order, on the checkouts CI actually produces', () => {
  /**
   * A dispatched run's checkout: the work branch, the whole remote fetched, and no `origin/HEAD`,
   * which `actions/checkout` does not record — the shape run 36764719955 refused.
   */
  function dispatched(payload) {
    const w = world(journal([288, 1000, '0288_main']));
    const work = pushBranch(w, 'iss-dispatched', journal([288, 1000, '0288_main']));
    spawnSync('git', ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD'], {
      cwd: work,
      env: SEALED_ENV,
    });
    const event = join(w.box, 'event.json');
    writeFileSync(event, JSON.stringify(payload));
    return run(work, {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/iss-dispatched',
      GITHUB_EVENT_PATH: event,
    });
  }

  it('measures a dispatched run against the base its dispatcher named, and says so', () => {
    const { code, out } = dispatched({ inputs: { base: 'main' } });
    expect(out).toContain('merge target main, from inputs.base');
    expect(code).toBe(0);
  });

  it('exits 2 on a dispatched run that named no base, naming the input', () => {
    const { code, out } = dispatched({ inputs: {} });
    expect(code).toBe(2);
    expect(out).toContain('names its merge target in inputs.base');
  });

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

  // `754440730` gave the checker a reading of `GITHUB_HEAD_REF`; this fixture kept spawning it with
  // the ambient one, so no pull request could pass `core` while `push` to main stayed green.
  it('answers the same whatever the environment around it says, subject and git alike', () => {
    const w = world(journal([288, 1000, '0288_main']));
    pushBranch(w, 'iss-first', journal([288, 1000, '0288_main'], [289, 2000, '0289_first']));
    const work = pushBranch(
      w,
      'iss-second',
      journal([288, 1000, '0288_main'], [290, 3000, '0290_second']),
    );
    const sealed = run(work);
    const sealedHead = git(work, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(sealed.code).toBe(0);
    expect(sealed.out).toContain('origin/iss-first');
    expect(sealedHead).toBe('iss-second');

    const polluted = { ...process.env };
    process.env.GITHUB_HEAD_REF = 'iss-second';
    process.env.GIT_DIR = join(w.box, 'origin.git');
    process.env.GIT_WORK_TREE = w.seed;
    try {
      expect(run(work)).toEqual(sealed);
      // `GIT_DIR` at the bare origin makes an inheriting `git -C work` answer for another repo.
      expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(sealedHead);
    } finally {
      process.env = polluted;
    }
  });
});
