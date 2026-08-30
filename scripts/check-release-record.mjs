#!/usr/bin/env node
// The release record cannot lose entries without someone saying so.
//
// On 2026-08-28 commit 3df9a8e9 removed 1,034 lines from `CHANGELOG.md` inside
// a commit about dangling docs pointers whose message never named the file.
// Every gate this repo had ran on it and passed: each axis of the day owned a
// property of the CODE and none owned the record. The in-app What's New feed
// went blank for every signed-in user and nothing said so.
//
// Two rules — `structure` (the record keeps the `## [Unreleased]` heading its
// five readers parse for) and `no-silent-loss` (every entry present at the base
// revision is still present at HEAD). Entries compare as a SET of
// whitespace-normalised texts, so a reflow is not a deletion and a release cut
// promoting `[Unreleased]` to `[X.Y.Z]` moves them all without tripping it.
//
// Removing an entry is legal and declared: one `{entry, reason}` in
// `.forge/changelog-amnesty.json`, so the trade-off lands in the diff where a
// reader can price it.
//
// Exit codes: 0 clean, 1 violations found, 2 could not run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';
import { judge } from './lib/release-record.mjs';

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
  console.error(
    `\nAn entry in ${RECORD} is a line someone published about what shipped. Restore what went\n` +
      `missing, or — if a removal is deliberate — declare it in ${AMNESTY} as\n` +
      `{"removals": [{"entry": "<the entry, verbatim>", "reason": "<why it goes>"}]} so the\n` +
      `trade-off is visible in the diff rather than only in the deletion.`,
  );
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
