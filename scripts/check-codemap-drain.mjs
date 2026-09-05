#!/usr/bin/env node

// Codemap baseline drain gate — CM013, scoped to this change.
//
// The knowledge axis froze 12,454 comments across 965 files at `cm init` and
// then blocked only prose that was NEW. Nothing ever asked the other question:
// if you are already editing this file, why is its frozen count still the same?
// Siting was the one drain path, and it fires only when an author reaches for a
// tag, so a file could be refactored for years with its debt untouched.
//
// The rule itself lives upstream in the vendored checker (`.forge/codemap/`,
// SPEC.md §8) because that is where baseline behaviour is owned. This script is
// the wiring: it hands cm a base revision and reports only CM013, because the
// whole-tree `cm verify` the prose gate runs CANNOT raise it — "edited" has no
// meaning without a base, and that gate is whole-tree for a measured reason
// (see the guard on `codemap prose` in scripts/verify.mjs).
//
// Exit codes: 0 clean, 1 unpaid debt on an edited file, 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { baseRev } from './lib/baseline-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CM = join(ROOT, '.forge', 'codemap', 'cm');
const BASELINE = join(ROOT, '.forge', 'codemap-baseline.json');

function die(msg) {
  console.error(`codemap-drain: ${msg}`);
  process.exit(2);
}

// cm:guard the count this reports is the BASELINE's file count, never the diff's — a docs-only branch legitimately touches zero source files, and verify.mjs turns a zero scan into exit 2, so counting the diff would fail the gate on every branch that changed no code
// cm:why zero here means the baseline is absent or unreadable, which is the state that must fail closed: without it nothing can tell inherited debt from debt this change introduced
/** Files the baseline freezes. Zero is "not onboarded", never "nothing frozen". */
function frozenFiles() {
  if (!existsSync(BASELINE)) die(`${BASELINE} not found — this repo is not cm-onboarded`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    die(`${BASELINE} is unreadable — ${err.message}`);
  }
  // cm:guard the pre-0.2 count format stores a number per file instead of a key list, and cm ignores it wholesale — a baseline nothing can read tells new prose from legacy for no file, so this gate has no ground to stand on and says so rather than reporting a clean diff
  const entries = Object.entries(raw).filter(([k]) => !k.startsWith('__'));
  if (entries.some(([, v]) => !Array.isArray(v)))
    die('baseline is in the pre-0.2 count format — run: .forge/codemap/cm baseline');
  return entries.length;
}

const files = frozenFiles();
if (files === 0) die('the baseline freezes no file — nothing can tell inherited prose from new');

if (!existsSync(CM)) die(`${CM} not found — the checker is vendored and committed (SPEC.md §8.1)`);

// cm:guard the base comes from baseRev(), never from a bare `git merge-base origin/main HEAD` — on a push straight to main those are equal and a scope compared against itself passes everything, which is the exact line that let 15 CM001 errors reach main; baseRev falls back to HEAD~1
// cm:why the resolved sha is printed below because an unstated base reads identically to a base nobody computed
const base = baseRev(ROOT);
if (!base)
  die('no base revision — a shallow or single-commit checkout cannot say what this change edited');

const r = spawnSync(CM, ['verify', '--since', base, '--tier', 'grammar', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

// cm:guard cm's exit 2 is "the gate could not run" and must be forwarded as this script's 2 — a
//   missing ref in a shallow clone otherwise reads as a lint failure, or worse as a clean diff
if (r.status === 2 || r.status === null || !r.stdout) {
  die((r.stderr || r.error?.message || `cm exited ${r.status}`).trim().split('\n')[0]);
}

let report;
try {
  report = JSON.parse(r.stdout);
} catch (err) {
  die(`cm --json output did not parse — ${err.message}`);
}

const unpaid = (report.diags ?? []).filter((d) => d.code === 'CM013');

for (const d of unpaid) {
  console.error(`${d.file}:${d.line} CM013 ${d.message}`);
  console.error(`  fix: ${d.fix}`);
}

console.log(
  `codemap-drain: ${files} file(s) frozen in the baseline · ${report.files} in this diff · ` +
    `${unpaid.length} unpaid (base ${base.slice(0, 8)})`,
);

if (unpaid.length) {
  console.error(
    `\ncodemap-drain: ${unpaid.length} edited file(s) paid none of their frozen comment debt.` +
      '\nDelete or reword one frozen comment in each — `.forge/codemap/cm sweep <file>` lists them.' +
      '\nA file whose comments genuinely may not be touched says so once: cm:ignore CM013 — <reason>.',
  );
}

process.exit(unpaid.length ? 1 : 0);
