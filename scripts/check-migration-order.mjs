#!/usr/bin/env node

/**
 * Whether the migrations this tree is landing can be applied alongside every open branch's: this
 * reads the set of open branches, not one journal. Origin and rules: `scripts/README.md`.
 * Exit 0 applicable · 1 a refusal naming the branches and numbers · 2 could not run, never a pass.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseRef as resolveBase } from './lib/base-branch.mjs';
import { gitOut } from './lib/gate.mjs';
import { checkSet, floorOf, newEntries, readJournal, readOpenSet } from './lib/migration-order.mjs';

const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
const LABEL = 'migration-order';

function say(line) {
  console.log(line);
}

function die(reason) {
  console.error(`${LABEL}: ${reason}`);
  process.exit(2);
}

const git = (args, cwd) => gitOut(args, cwd)?.trim() ?? null;

function entriesOf(text, where) {
  const read = readJournal(text, where);
  if (read.problem) die(read.problem);
  return read.doc.entries;
}

const root = git(['rev-parse', '--show-toplevel'], process.cwd());
if (!root) die('this is not a git checkout, so no branch and no remote can be read');

const journalPath = join(root, JOURNAL);
if (!existsSync(journalPath)) die(`there is no journal at ${JOURNAL}`);
const here = entriesOf(readFileSync(journalPath, 'utf8'), JOURNAL);

// The floor comes from the branch this work lands on, never from `main` by assumption: a floor off
// a branch the work does not derive from hands back a `when` somebody has already taken.
const base = resolveBase(root);
if (base.refusal) {
  die(
    `${base.refusal}\n` +
      'Without it the floor every migration must clear cannot be read, and a run that cannot\n' +
      'read the floor has measured nothing — which is why this is exit 2 and not a pass.',
  );
}
const baseRef = base.ref;

function journalAt(ref) {
  const text = git(['show', `${ref}:${JOURNAL}`], root);
  if (text === null) die(`${ref} carries no readable ${JOURNAL}, so there is no floor to clear`);
  return entriesOf(text, `${ref}:${JOURNAL}`);
}

let baseEntries = journalAt(baseRef);

/**
 * What to call this tree, and which remote refs are it rather than a sibling. Three readings say
 * "this is us" — the name HEAD is on, the branch GitHub says the PR came from, and any ref this
 * tree contains — because a detached merge ref would otherwise refuse the PR against itself.
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

let landing = newEntries(here, baseEntries);
let isBase = git(['rev-parse', 'HEAD'], root) === git(['rev-parse', baseRef], root);

// A tree that adds no migration asserts nothing about the set, so it reads nothing. This is the
// one path that skips the remote, and it skips it on a proposition proved from local data rather
// than on a failure to reach it: the base branch only ever GAINS entries, so a journal that adds
// nothing to a stale base adds nothing to the current one either.
if (landing.length === 0 && !isBase) {
  say(`${LABEL}: 0 migration(s) landing, 0 open branch(es) read`);
  say(
    `  ${branch} adds no migration to ${baseRef} (merge target ${base.branch}, from ${base.source}),`,
  );
  say('  so the open set was not read.');
  say('  No merge order and no next-free number are claimed here.');
  process.exit(0);
}

/** Every open branch's new entries, or `null` where the remote could not be read at all. */
function readOpenBranches() {
  const read = readOpenSet({
    git: (args) => git(args, root),
    isAncestor: (ref, commit) => {
      const r = spawnSync('git', ['merge-base', '--is-ancestor', ref, commit], { cwd: root });
      return r.status === 0 ? true : r.status === 1 ? false : null;
    },
    journal: JOURNAL,
    baseRef,
    isOurs,
    parse: entriesOf,
    // The fetch may have moved the base under us, and the floor was read before it. Re-read rather
    // than compare against a number the remote has already left behind.
    afterFetch: () => {
      baseEntries = journalAt(baseRef);
      landing = newEntries(here, baseEntries);
      isBase = git(['rev-parse', 'HEAD'], root) === git(['rev-parse', baseRef], root);
      return baseEntries;
    },
  });
  if (read?.hole?.kind === 'ancestry') {
    die(
      `whether ${read.hole.ref} is already on ${baseRef} could not be read, so whether its\n` +
        'migrations are open is unknown. An unknown is not an absence. Exit 2, not a pass.',
    );
  }
  if (read?.hole?.kind === 'tree') {
    die(
      `${read.hole.ref}'s tree could not be read, so whether it carries a ${JOURNAL} is unknown.\n` +
        'An unknown is not an absence. Exit 2, not a pass.',
    );
  }
  if (read?.hole?.kind === 'journal') {
    die(
      `${read.hole.ref} has a ${JOURNAL} that will not read, so the open set has a hole in it.\n` +
        'Nothing can be said about an order that leaves one branch out, and this tree is\n' +
        `landing ${landing.map((e) => e.tag).join(', ') || 'no migration'}. Exit 2, not a pass.`,
    );
  }
  return read === null ? null : read.open;
}

const siblings = readOpenBranches();

// The fetch inside that call may have shown that the base already carries what this tree was
// landing.
if (siblings !== null && landing.length === 0 && !isBase) {
  say(`${LABEL}: 0 migration(s) landing, ${siblings.length} open branch(es) read`);
  say(`  ${baseRef} already carries every migration in this journal, so there is none to order.`);
  process.exit(0);
}

if (siblings === null) {
  if (landing.length === 0) {
    // The base branch asserts nothing about anybody's numbers — it has already landed. The report
    // below is the only thing it owed, so a remote it cannot reach costs the report and not the run.
    say(`${LABEL}: 0 migration(s) landing, 0 open branch(es) read`);
    say(`  ${baseRef} could not be compared against the open branches: the remote did not answer.`);
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

const result = checkSet({
  base: baseEntries,
  baseRef,
  self: { branch, entries: landing },
  siblings,
});

say(`${LABEL}: ${landing.length} migration(s) landing, ${siblings.length} open branch(es) read`);
say(
  `  ${baseRef} floor: ${floorOf(baseEntries)} (merge target ${base.branch}, from ${base.source})`,
);

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
  console.error(
    `  Take it rather than deriving one from ${baseRef} alone: the base is not the set.\n`,
  );
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
