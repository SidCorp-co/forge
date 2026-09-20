#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRev, ratchetFault } from './lib/baseline-ratchet.mjs';
import { absentPrerequisites, couldNotStart, remedyLines } from './lib/prerequisite.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

const PROBES = {
  form: {
    gate: 'check-size-budget + check-lint-budget + biome + check-provider-literals + check-integration-declarations',
    probe: ['node', 'scripts/check-size-budget.mjs', '--all'],
    needs: ['deps'],
    also: [
      {
        from: 'alsoBaseline',
        needs: ['deps'],
        probe: ['node', 'scripts/check-lint-budget.mjs', '--all'],
      },
      { from: 'none', probe: ['node', 'scripts/check-provider-literals.mjs'] },
      { from: 'none', probe: ['node', 'scripts/check-integration-declarations.mjs'] },
    ],
  },
  knowledge: {
    gate:
      'check-honest-costs + check-injected-doc-modes + check-pat-surface + check-status-tuples + check-doc-citations',
    probe: ['node', 'scripts/check-honest-costs.mjs'],
    from: 'none',
    also: [
      { from: 'none', probe: ['node', 'scripts/check-injected-doc-modes.mjs'] },
      { from: 'none', probe: ['node', 'scripts/check-pat-surface.mjs'] },
      { from: 'none', probe: ['node', 'scripts/check-status-tuples.mjs', '--all'] },
      { from: 'none', probe: ['node', 'scripts/check-doc-citations.mjs', '--all'] },
    ],
  },
  relations: {
    gate: 'archmap check',
    probe: ['./.forge/archmap/archmap', 'check'],
    needs: ['deps'],
  },
  behaviour: {
    gate: 'check-test-signal + check-flow-coverage + check-test-reachability',
    probe: ['node', 'scripts/check-test-signal.mjs', '--all'],
    also: [
      { from: 'alsoBaseline', probe: ['node', 'scripts/check-flow-coverage.mjs', '--all'] },
      { from: 'none', needs: ['deps'], probe: ['node', 'scripts/check-test-reachability.mjs'] },
    ],
  },
  language: {
    gate: 'check-source-language',
    probe: ['node', 'scripts/check-source-language.mjs', '--all'],
  },
  record: {
    gate: 'check-release-record',
    probe: ['node', 'scripts/check-release-record.mjs'],
  },
  comment: {
    gate: 'check-comment-budget',
    probe: ['node', 'scripts/check-comment-budget.mjs', '--all'],
    needs: ['deps'],
  },
};

const IMPROVES = ['down', 'shrink', 'tighten'];
const BASE_REV = baseRev(ROOT);

function declaredBaselines(decl) {
  return [decl.baseline, decl.alsoBaseline].filter((b) => b !== undefined);
}

function baselineFault(level, decl) {
  if (level !== 2) return null;
  if (decl === undefined) return 'declares no baseline — level 2 needs one';
  if (decl === null) return 'declares baseline null at level 2 — nothing is frozen';
  if (!decl.path) return 'baseline entry has no path';
  if (!existsSync(join(ROOT, decl.path))) return `${decl.path} is declared but absent`;
  if (!IMPROVES.includes(decl.improves)) {
    return `${decl.path} declares improves=${decl.improves ?? 'nothing'}, not one of ${IMPROVES.join('/')}`;
  }
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

function measureOne(spec, baselinePath) {
  const missing = absentPrerequisites(ROOT, spec.needs);
  if (missing.length > 0) return { level: null, blocked: missing, note: remedyLines(missing)[0] };

  const r = spawnSync(spec.probe[0], spec.probe.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (couldNotStart(r)) {
    return { level: null, blocked: [], note: `${spec.probe[0]} is not executable here` };
  }
  if (r.error) return { level: null, blocked: [], note: `cannot run: ${r.error.message}` };
  if (r.status === 2)
    return { level: null, blocked: [], note: 'checker reported it could not run' };

  const hasBaseline = baselinePath ? existsSync(join(ROOT, baselinePath)) : false;
  if (r.status === 1) return { level: 2, note: 'blocking, violations present' };
  if (hasBaseline) return { level: 2, note: 'blocking, baseline frozen' };
  return { level: 3, note: 'blocking, no baseline' };
}

function measure(_axis, spec, decl) {
  const paths = {
    baseline: decl.baseline?.path ?? null,
    alsoBaseline: decl.alsoBaseline?.path ?? null,
    none: null,
  };
  return [spec, ...(spec.also ?? [])]
    .map((s) => measureOne(s, paths[s.from ?? 'baseline']))
    .reduce((weakest, m) => {
      if (weakest.level === null) return weakest;
      return m.level === null || m.level < weakest.level ? m : weakest;
    });
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

const ratchetable = Object.values(declared)
  .filter((a) => a?.level === 2)
  .flatMap((a) => declaredBaselines(a))
  .filter((b) => b?.path && IMPROVES.includes(b.improves));
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
let unmeasured = 0;

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
  if (m.level === null) {
    unmeasured++;
    rows.push({ axis, gate: spec.gate, declared: d, measured: 'n/a', note: m.note });
    continue;
  }
  const fault =
    declaredBaselines(declared[axis])
      .map((b) => baselineFault(d, b))
      .find(Boolean) ?? null;
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
  const flag = r.measured === 'n/a' ? '?' : r.declared === r.measured ? ' ' : '!';
  console.log(
    `${flag} ${r.axis.padEnd(11)} ${String(r.gate).padEnd(w)}  ${String(r.declared).padEnd(8)}  ${String(r.measured).padEnd(8)}  ${r.note}`,
  );
}

if (ratchetable.length > 0) {
  const short = BASE_REV.slice(0, 8);
  console.log(`\n  ${ratchetable.length} baseline(s) judged for direction against ${short}`);
}

const gates = ciGates();
if (gates) console.log(`\n  ci-passed needs ${gates.length} job(s): ${gates.join(' ')}`);

console.log(`\nconformance-status: ${rows.length} axes measured`);

if (rows.length === 0) {
  console.error(
    'conformance-status: the manifest declares no axes and no probe fired — this is\n' +
      'scanned-nothing, not agreement. Exit 2, because a status report over an empty\n' +
      'set is the fail-open shape this whole system exists to refuse.\n',
  );
  process.exit(2);
}

if (unmeasured > 0) {
  console.error(
    `\nconformance-status: ${unmeasured} axis/axes could not be measured — the probe's tool is\n` +
      'not on disk. That is a fact about this checkout, not about the repo: no level below\n' +
      'was compared for those axes and none of them is claimed to overstate anything.\n' +
      `Exit 2, because ${unmeasured} unmeasured axis/axes is not agreement.\n`,
  );
  for (const r of rows.filter((x) => x.measured === 'n/a')) {
    console.error(`  ${r.axis}: ${r.note}`);
  }
  console.error('');
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
