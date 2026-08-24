#!/usr/bin/env node
// Report each conformance axis at the level it MEASURES, not the level a
// document claims for it.
//
// Every gate this repo has lost was lost the same way: it stayed documented
// while it stopped blocking. biome drifted to 366 errors, typecheck to 84, and
// the two length rules to 143 — each of them described in CLAUDE.md as gating
// something the whole time it gated nothing. A written level is a claim; this
// runs the checker and reports what came back.
//
// Levels, shared by every axis:
//   0  no checker
//   1  measure — runs, prints, does not block
//   2  freeze — baseline the old, block the new
//   3  lock — zero violations, no baseline
//
// The declared level lives in .forge/conformance.json. This compares it against
// what the checkers actually do and fails when the two disagree, so the manifest
// cannot quietly become the next thing that lies.
//
// Exit: 0 declared matches measured · 1 they disagree · 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRev, ratchetFault } from './lib/baseline-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

// cm:edge lockstep -> .forge/conformance.json — one entry per axis declared there; an axis in the manifest with no probe here, or a probe with no manifest entry, fails this check rather than going unreported
// cm:guard this table holds COMMANDS only — every baseline path is read from the manifest, never repeated here. A second copy of a path is a second thing to keep true, and the manifest is the half a reader is entitled to trust.
const PROBES = {
  form: {
    gate: 'check-size-budget + check-lint-budget + biome',
    probe: ['node', 'scripts/check-size-budget.mjs', '--all'],
    also: [{ from: 'alsoBaseline', probe: ['node', 'scripts/check-lint-budget.mjs', '--all'] }],
  },
  knowledge: {
    gate: 'cm verify',
    probe: ['.forge/codemap/cm', 'verify', '--tier', 'referential'],
  },
  relations: {
    gate: 'arch check',
    // cm:why archmap carries its baseline INSIDE .arch.json as each contract's draft/locked status rather than in a separate frozen file — `locked` already means "no new violations", not "zero violations", which is level 2 by the same definition the other axes use
    probe: ['./.forge/archmap/archmap', 'check'],
  },
  // cm:guard an axis with several checkers measures at the WEAKEST of them. Reporting the strongest would let one locked checker hide a sibling that stopped blocking, which is the drift this whole script exists to catch.
  behaviour: {
    gate: 'check-test-signal + check-flow-coverage',
    probe: ['node', 'scripts/check-test-signal.mjs', '--all'],
    also: [{ from: 'alsoBaseline', probe: ['node', 'scripts/check-flow-coverage.mjs', '--all'] }],
  },
  language: {
    gate: 'check-source-language',
    probe: ['node', 'scripts/check-source-language.mjs', '--all'],
  },
};

const IMPROVES = ['down', 'shrink', 'tighten'];
const BASE_REV = baseRev(ROOT);

// cm:guard level 2 IS the claim "old debt frozen, new debt blocked", so a level-2 axis whose declared baseline is absent, or whose direction is undeclared, has no frozen half — report the axis at the level it can actually prove, never at the one it claims.
function baselineFault(level, decl) {
  if (level !== 2) return null;
  if (decl === undefined) return 'declares no baseline — level 2 needs one';
  if (decl === null) return 'declares baseline null at level 2 — nothing is frozen';
  if (!decl.path) return 'baseline entry has no path';
  if (!existsSync(join(ROOT, decl.path))) return `${decl.path} is declared but absent`;
  if (!IMPROVES.includes(decl.improves)) {
    return `${decl.path} declares improves=${decl.improves ?? 'nothing'}, not one of ${IMPROVES.join('/')}`;
  }
  // cm:edge protocol -> scripts/lib/baseline-ratchet.mjs — everything above judges the DECLARATION, this line judges the FILE against its own previous state; for most of this repo's life only the declaration was checked, so `--update-baseline` could re-freeze any baseline larger and every gate stayed green
  return ratchetFault(ROOT, BASE_REV, decl);
}

function readManifest() {
  if (!existsSync(CONFIG_PATH)) return { error: `${CONFIG_PATH} not found` };
  try {
    return { manifest: JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    return { error: `${CONFIG_PATH} is unreadable — ${err.message}` };
  }
}

// cm:guard measure by RUNNING the checker, never by reading the manifest. Reading the declaration and printing it back is what every drifted gate already did.
function measureOne(spec, baselinePath) {
  const r = spawnSync(spec.probe[0], spec.probe.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { level: 0, note: `cannot run: ${r.error.message}` };
  if (r.status === 2) return { level: 0, note: 'checker reported it could not run' };

  const hasBaseline = baselinePath ? existsSync(join(ROOT, baselinePath)) : false;
  if (r.status === 1) return { level: 2, note: 'blocking, violations present' };
  if (hasBaseline) return { level: 2, note: 'blocking, baseline frozen' };
  return { level: 3, note: 'blocking, no baseline' };
}

function measure(_axis, spec, decl) {
  const paths = {
    baseline: decl.baseline?.path ?? null,
    alsoBaseline: decl.alsoBaseline?.path ?? null,
  };
  return [spec, ...(spec.also ?? [])]
    .map((s) => measureOne(s, paths[s.from ?? 'baseline']))
    .reduce((weakest, m) => (m.level < weakest.level ? m : weakest));
}

function ciGates() {
  const ci = join(ROOT, '.github', 'workflows', 'ci.yml');
  if (!existsSync(ci)) return null;
  const text = readFileSync(ci, 'utf8');
  const needs = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(text);
  return needs
    ? needs[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
}

const { manifest, error } = readManifest();
if (error) {
  console.error(`conformance-status: ${error}`);
  process.exit(2);
}

const declared = manifest.axes ?? {};

// cm:guard a missing base revision must EXIT 2, never pass quietly. Measured 2026-08-24: the `conformance` job checked out at depth 1, so `HEAD~1` and `origin/main` were both absent, `baseRev` returned null, every ratchet comparison was skipped and CI went green on a check that never ran. A shallow checkout is a gate that could not run, which is the one thing this repo refuses to read as a pass.
const ratchetable = Object.values(declared).filter(
  (a) => a?.level === 2 && a?.baseline?.path && IMPROVES.includes(a.baseline.improves),
);
if (ratchetable.length > 0 && BASE_REV === null) {
  console.error(
    `conformance-status: ${ratchetable.length} axis/axes declare a baseline direction, and there is\n` +
      'no revision to compare against — no origin/main and no HEAD~1. That is a shallow or\n' +
      'single-commit checkout, so the direction check would silently pass on nothing.\n' +
      'Fetch history (actions/checkout with fetch-depth: 0) and re-run.\n',
  );
  process.exit(2);
}
const axes = [...new Set([...Object.keys(PROBES), ...Object.keys(declared)])].sort();
const rows = [];
let disagreements = 0;

for (const axis of axes) {
  const spec = PROBES[axis];
  if (!spec) {
    rows.push({
      axis,
      gate: '—',
      declared: declared[axis]?.level ?? '?',
      measured: '?',
      note: 'declared with no probe',
    });
    disagreements++;
    continue;
  }
  if (!(axis in declared)) {
    rows.push({
      axis,
      gate: spec.gate,
      declared: '—',
      measured: '?',
      note: 'probed but not declared',
    });
    disagreements++;
    continue;
  }
  const m = measure(axis, spec, declared[axis]);
  const d = declared[axis].level;
  const fault = baselineFault(d, declared[axis].baseline);
  if (d !== m.level || fault) disagreements++;
  rows.push({
    axis,
    gate: spec.gate,
    declared: d,
    measured: fault ? '!' : m.level,
    note: fault ?? m.note,
  });
}

const w = Math.max(...rows.map((r) => r.gate.length), 10);
console.log(`\n  axis        gate${' '.repeat(w - 4)}declared  measured`);
for (const r of rows) {
  const flag = r.declared === r.measured ? ' ' : '!';
  console.log(
    `${flag} ${r.axis.padEnd(11)} ${String(r.gate).padEnd(w)}  ${String(r.declared).padEnd(8)}  ${String(r.measured).padEnd(8)}  ${r.note}`,
  );
}

// cm:guard PRINT what the ratchet compared against. A silent direction check is indistinguishable from one that skipped — which is exactly what shipped: depth-1 CI made every comparison a no-op and the log looked identical to a real pass. This line is the difference between inferring it ran and seeing it.
if (ratchetable.length > 0) {
  const short = BASE_REV.slice(0, 8);
  console.log(`\n  ${ratchetable.length} baseline(s) judged for direction against ${short}`);
}

const gates = ciGates();
if (gates) console.log(`\n  ci-passed needs ${gates.length} job(s): ${gates.join(' ')}`);

// cm:edge naming -> scripts/verify.mjs — its `conformance levels` entry parses this line for the axis count; a manifest whose axes map is empty must read as scanned-nothing, not as agreement
console.log(`\nconformance-status: ${rows.length} axes measured`);

if (rows.length === 0) {
  console.error(
    'conformance-status: the manifest declares no axes and no probe fired — this is\n' +
      'scanned-nothing, not agreement. Exit 2, because a status report over an empty\n' +
      'set is the fail-open shape this whole system exists to refuse.\n',
  );
  process.exit(2);
}

if (disagreements === 0) {
  console.log('\nconformance: declared levels match measured\n');
  process.exit(0);
}
console.error(
  `\nconformance: ${disagreements} axis/axes where the manifest and the checkers disagree.\n` +
    'Fix the axis or fix the claim — a manifest that overstates a level is the\n' +
    'failure mode it exists to prevent.\n',
);
process.exit(1);
