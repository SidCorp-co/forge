#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';
import { CORRECTION_SPAN, ENTRY_WORD_BUDGET, judge } from './lib/release-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = 'CHANGELOG.md';
const AMNESTY = '.forge/changelog-amnesty.json';

function readAt(rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readWorkingTree(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function amnesty() {
  const raw = readWorkingTree(AMNESTY);
  if (raw === null) return { removals: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function report(verdict) {
  for (const v of verdict.violations ?? []) {
    console.error(`release-record: ${v.rule} — ${v.detail}`);
    for (const entry of (v.removed ?? []).slice(0, 5)) {
      console.error(`  - ${entry.length > 160 ? `${entry.slice(0, 157)}...` : entry}`);
    }
    const extra = (v.removed?.length ?? 0) - 5;
    if (extra > 0) console.error(`  ... and ${extra} more`);
  }
  const rules = new Set((verdict.violations ?? []).map((v) => v.rule));
  if (rules.has('no-silent-loss')) {
    console.error(
      `\nAn entry in ${RECORD} is a line someone published about what shipped. A CORRECTION to one is\n` +
        `read as that entry and is not listed here. A correction is an added entry into which more than\n` +
        `half the words of the LONGER of the two survived in order, AND which moved at most ${CORRECTION_SPAN} words each\n` +
        `way: at most ${CORRECTION_SPAN} of the published entry's words gone, and at most ${CORRECTION_SPAN} new ones standing where\n` +
        `they were. One removed entry pairs with one added entry, and the pairing takes as many pairs as\n` +
        `it can before it prefers the likeliest single one. What IS listed found no such correction among\n` +
        `what this change added — a wider change is a withdrawal and a new entry however much of the\n` +
        `wording it carries over. Restore it, or — if the removal is deliberate — declare it in\n` +
        `${AMNESTY} as\n` +
        `{"removals": [{"entry": "<the entry, verbatim>", "reason": "<why it goes>"}]} so the trade-off is\n` +
        `visible in the diff rather than only in the deletion.`,
    );
  }
  // Deliberately no amnesty for this one: an over-long entry is rewritten, and a file that
  // let you declare your way past the budget would be the budget's off switch.
  if (rules.has('entry-budget')) {
    console.error(
      `\nThe budget is ${ENTRY_WORD_BUDGET} words for an entry this change ADDS. An entry it CORRECTS may spend the\n` +
        `larger of the ${ENTRY_WORD_BUDGET} and the words that entry already held, so a published entry can be corrected\n` +
        `without first being cut to a budget written after it. A correction is an added entry into which\n` +
        `more than half the words of the LONGER of the two survived in order, AND which moved at most ${CORRECTION_SPAN}\n` +
        `words each way — at most ${CORRECTION_SPAN} of the published entry's words gone, at most ${CORRECTION_SPAN} new ones standing\n` +
        `where they were — one removed entry to one added entry. Anything wider is a new entry and pays\n` +
        `the ${ENTRY_WORD_BUDGET}, whatever share of the wording it keeps: a long entry holding enough background can\n` +
        `clear a SHARE with its whole claim replaced, and no share can be set high enough to say\n` +
        `otherwise. An entry left alone turns this red under no circumstance. There is no amnesty for it:\n` +
        `rewrite the entry. Say what changed and what it means for the reader; leave the reasoning in the\n` +
        `issue and the commit message.`,
    );
  }
}

function main() {
  const head = readWorkingTree(RECORD);
  if (head === null) {
    console.error(
      `release-record: could not run — ${RECORD} is absent. The record is not a file this repo\n` +
        `may stop keeping; if it truly moves, retarget its five readers in the same change.`,
    );
    return 2;
  }

  const declared = amnesty();
  if (declared === null) {
    console.error(`release-record: could not run — ${AMNESTY} is present but is not valid JSON`);
    return 2;
  }

  const rev = baseRev(ROOT);
  const verdict = judge({
    head,
    base: rev === null ? null : readAt(rev, RECORD),
    amnesty: declared,
  });

  if (verdict.code === 2) {
    console.error(
      `release-record: could not run — ${verdict.reason}. This rule compares the record against\n` +
        `its base revision, so a shallow checkout has nothing to check. Run \`git fetch origin main\`,\n` +
        `or give the CI job \`fetch-depth: 0\`.`,
    );
    return 2;
  }
  if (verdict.code === 1) {
    report(verdict);
    return 1;
  }

  console.log(
    `release-record: ${verdict.entries} entr${verdict.entries === 1 ? 'y' : 'ies'} held across ${verdict.sections} section(s)`,
  );
  return 0;
}

process.exit(main());
