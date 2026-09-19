#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';
import { ENTRY_WORD_BUDGET, judge } from './lib/release-record.mjs';

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
      `\nAn entry in ${RECORD} is a line someone published about what shipped. Restore what went\n` +
        `missing, or — if a removal is deliberate — declare it in ${AMNESTY} as\n` +
        `{"removals": [{"entry": "<the entry, verbatim>", "reason": "<why it goes>"}]} so the\n` +
        `trade-off is visible in the diff rather than only in the deletion.`,
    );
  }
  // Deliberately no amnesty for this one: an over-long entry is rewritten, and a file that
  // let you declare your way past the budget would be the budget's off switch.
  if (rules.has('entry-budget')) {
    console.error(
      `\nThe budget is ${ENTRY_WORD_BUDGET} words per entry and it applies only to entries this change\n` +
        `adds — nothing already published turns this red. There is no amnesty for it: rewrite the\n` +
        `entry. Say what changed and what it means for the reader; leave the reasoning in the issue\n` +
        `and the commit message, where it is not competing with every other release for attention.`,
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
