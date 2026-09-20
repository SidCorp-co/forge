#!/usr/bin/env node

/**
 * Whether the migrations this tree is landing can be applied alongside every open branch's.
 *
 * `packages/core/src/db/migrations-journal.test.ts` owns the properties of ONE journal and reads
 * only its own, so every branch passes alone while the set of open branches is measured by nothing.
 * That is how a migration is lost: drizzle applies entries above the single high-water mark it
 * reads once, so a branch merging second with a lower `when` is skipped silently and for ever
 * (ISS-807 — a live 500 on `GET /me/attention` for every signed-in user). This reads the set.
 *
 * Exit 0 the set is applicable · 1 a refusal, naming the branches and the numbers · 2 the check
 * could not run, which is never a pass: a check that cannot see the set while a migration is being
 * landed has proved nothing, and saying so is the whole point.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSet, floorOf, newEntries } from './lib/migration-order.mjs';

const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
const MAIN_CANDIDATES = ['origin/main', 'refs/remotes/origin/main', 'main'];
const LABEL = 'migration-order';

function say(line) {
  console.log(line);
}

function die(reason) {
  console.error(`${LABEL}: ${reason}`);
  process.exit(2);
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function entriesOf(text, where) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    die(`the journal at ${where} is not readable JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed?.entries)) die(`the journal at ${where} carries no \`entries\` array`);
  for (const e of parsed.entries) {
    if (typeof e?.idx !== 'number' || typeof e?.when !== 'number' || typeof e?.tag !== 'string') {
      die(`the journal at ${where} holds an entry without idx, when and tag: ${JSON.stringify(e)}`);
    }
  }
  return parsed.entries;
}

const root = git(['rev-parse', '--show-toplevel'], process.cwd());
if (!root) die('this is not a git checkout, so no branch and no remote can be read');

const journalPath = join(root, JOURNAL);
if (!existsSync(journalPath)) die(`there is no journal at ${JOURNAL}`);
const here = entriesOf(readFileSync(journalPath, 'utf8'), JOURNAL);

const mainRef = MAIN_CANDIDATES.find((ref) =>
  git(['rev-parse', '--verify', `${ref}^{commit}`], root),
);
if (!mainRef) {
  die(
    'origin/main does not resolve in this checkout, so the floor every migration must clear\n' +
      'cannot be read. Fetch it — `git fetch origin main` — and run this again. A run that\n' +
      'cannot see main has measured nothing, which is why this is exit 2 and not a pass.',
  );
}

function journalAt(ref) {
  const text = git(['show', `${ref}:${JOURNAL}`], root);
  if (text === null) die(`${ref} carries no readable ${JOURNAL}, so there is no floor to clear`);
  return entriesOf(text, `${ref}:${JOURNAL}`);
}

let main = journalAt(mainRef);

/**
 * What to call this tree, and which remote refs are it rather than a sibling.
 *
 * On a `pull_request` run `actions/checkout` leaves HEAD detached on the merge ref, so
 * `--abbrev-ref HEAD` answers `HEAD` and the PR's own branch would be read as a sibling holding
 * every one of this tree's migrations — a duplicate-`when` and duplicate-index refusal against
 * itself, on every migration-bearing PR. Three readings say "this is us", and a ref matching any
 * of them is not a sibling: the name HEAD is on, the branch GitHub says the PR came from, and any
 * ref this tree already contains.
 */
const headName = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
const prBranch = process.env.GITHUB_HEAD_REF?.trim();
const branch = prBranch || (headName && headName !== 'HEAD' ? headName : 'this tree');
const ourRefs = new Set(
  [headName, prBranch].filter((n) => n && n !== 'HEAD').map((n) => `origin/${n}`),
);

function isOurs(ref) {
  if (ourRefs.has(ref)) return true;
  return spawnSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: root }).status === 0;
}

let landing = newEntries(here, main);
let isMain = git(['rev-parse', 'HEAD'], root) === git(['rev-parse', mainRef], root);

// A tree that adds no migration asserts nothing about the set, so it reads nothing. This is the
// one path that skips the remote, and it skips it on a proposition proved from local data rather
// than on a failure to reach it: `main` only ever GAINS entries, so a journal that adds nothing to
// a stale main adds nothing to the current one either.
if (landing.length === 0 && !isMain) {
  say(`${LABEL}: 0 migration(s) landing, 0 open branch(es) read`);
  say(`  ${branch} adds no migration to ${mainRef}, so the open set was not read.`);
  say('  No merge order and no next-free number are claimed here.');
  process.exit(0);
}

/** Every open branch's new entries, or `null` where the remote could not be read at all. */
function readOpenBranches() {
  const fetched = git(
    ['fetch', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
    root,
  );
  if (fetched === null) return null;
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], root);
  if (refs === null) return null;

  // The fetch may have moved main under us, and the floor this whole check is measured against
  // was read before it. Re-read everything derived from main rather than comparing this tree
  // against a number the remote has already left behind.
  main = journalAt(mainRef);
  landing = newEntries(here, main);
  isMain = git(['rev-parse', 'HEAD'], root) === git(['rev-parse', mainRef], root);

  const open = [];
  for (const ref of refs.split('\n').filter(Boolean)) {
    if (ref === 'origin/HEAD' || ref === mainRef || isOurs(ref)) continue;
    // Already merged: its entries are main's, and a branch nobody deleted is not a pending merge.
    if (
      spawnSync('git', ['merge-base', '--is-ancestor', ref, mainRef], { cwd: root }).status === 0
    ) {
      continue;
    }
    // A branch with no journal file carries no migration and is nothing to order against. A
    // journal that IS there and will not read is a hole in the set, and a hole is not an absence:
    // passing over it would be exactly the unmeasured landing this check exists to refuse.
    //
    // Absence is established POSITIVELY, by listing the tree. Probing the path instead — `cat-file
    // -e` — answers non-zero for "not in this tree" and for "git could not inspect the object"
    // alike, so the second would leave the branch out of the set under the name of the first.
    const listed = git(['ls-tree', '--name-only', ref, '--', JOURNAL], root);
    if (listed === null) {
      die(
        `${ref}'s tree could not be read, so whether it carries a ${JOURNAL} is unknown.\n` +
          'An unknown is not an absence. Exit 2, not a pass.',
      );
    }
    if (listed === '') continue;
    const text = git(['show', `${ref}:${JOURNAL}`], root);
    if (text === null) {
      die(
        `${ref} has a ${JOURNAL} that will not read, so the open set has a hole in it.\n` +
          'Nothing can be said about an order that leaves one branch out, and this tree is\n' +
          `landing ${landing.map((e) => e.tag).join(', ') || 'no migration'}. Exit 2, not a pass.`,
      );
    }
    const entries = newEntries(entriesOf(text, `${ref}:${JOURNAL}`), main);
    if (entries.length > 0) open.push({ branch: ref, entries });
  }
  return open;
}

const siblings = readOpenBranches();

// The fetch inside that call may have shown that main already carries what this tree was landing.
if (siblings !== null && landing.length === 0 && !isMain) {
  say(`${LABEL}: 0 migration(s) landing, ${siblings.length} open branch(es) read`);
  say(`  ${mainRef} already carries every migration in this journal, so there is none to order.`);
  process.exit(0);
}

if (siblings === null) {
  if (landing.length === 0) {
    // `main` asserts nothing about anybody's numbers — it has already landed. The report below is
    // the only thing it owed, so a remote it cannot reach costs the report and not the run.
    say(`${LABEL}: 0 migration(s) landing, 0 open branch(es) read`);
    say(`  ${mainRef} could not be compared against the open branches: the remote did not answer.`);
    say('  Nothing is claimed about them. This tree lands no migration of its own.');
    process.exit(0);
  }
  die(
    `${branch} is landing ${landing.length} migration(s) — ${landing.map((e) => e.tag).join(', ')} —\n` +
      'and the open branches could not be enumerated: `git fetch origin` did not answer.\n' +
      'The one thing this check exists to compare them against is unreadable, so there is no\n' +
      'verdict to give. Restore the remote and run it again; this is exit 2 and not a pass,\n' +
      'because a migration that lands unmeasured is the failure, not the risk.',
  );
}

const result = checkSet({ main, self: { branch, entries: landing }, siblings });

say(`${LABEL}: ${landing.length} migration(s) landing, ${siblings.length} open branch(es) read`);
say(`  ${mainRef} floor: ${floorOf(main)}`);

if (result.stranded.length > 0) {
  say('');
  say('  Already below the floor, and not counted against anybody — these branches cannot land');
  say('  until they renumber, whatever this tree does:');
  for (const b of result.stranded) {
    say(`    ${b.branch}: ${b.entries.map((e) => `${e.tag} (when ${e.when})`).join(', ')}`);
  }
}

if (result.refusals.length > 0) {
  console.error('');
  console.error(`${LABEL}: ${result.refusals.length} refusal(s) — this set has no merge order.`);
  for (const r of result.refusals) console.error(`\n  [${r.rule}] ${r.message}`);
  console.error(`\n  The next free number is when ${result.next.when}, index ${result.next.idx}.`);
  console.error('  Take it rather than deriving one from main alone: main is not the set.\n');
  process.exit(1);
}

if (result.betweenSiblings.length > 0) {
  say('');
  say('  Two open branches that cannot both land, in any order. Neither is this tree, so this');
  say('  run refuses nothing for them — but the set has no whole merge order while they stand,');
  say('  and none is printed below:');
  for (const r of result.betweenSiblings) say(`\n    [${r.rule}] ${r.message}`);
  say('');
  say(`  Next free: when ${result.next.when}, index ${result.next.idx}.`);
  process.exit(0);
}

say('');
say('  Merge order, derived across the open set — merge lowest `when` first:');
for (const [i, b] of result.order.entries()) {
  const mine = b.branch === branch ? '  <- this tree' : '';
  say(`    ${i + 1}. ${b.branch}: ${b.entries.map((e) => e.tag).join(', ')}${mine}`);
}
if (result.strandedByUs.length > 0) {
  say('');
  say(`  ${branch} is not first in that order. Landing it first costs a renumber:`);
  for (const b of result.strandedByUs) {
    say(`    ${b.branch} would have to renumber ${b.entries.map((e) => e.tag).join(', ')}`);
  }
}
say('');
say(`  Next free: when ${result.next.when}, index ${result.next.idx}.`);
process.exit(0);
