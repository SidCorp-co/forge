#!/usr/bin/env node
// Every declared cm:flow step must be reached by the integration suite.
//
// The join between the knowledge axis and the behaviour axis: a `cm:flow`
// annotation says "this line is step 4 of the dispatch flow", coverage says which
// lines a test ran, and a step named in the map and executed by nothing is a step
// the next editor believes is defended. It is measured, never declared.
//
// THE EVIDENCE IS istanbul's per-function invocation count (`f`): a step counts
// as reached when the authoritative suite ENTERED the annotated function, which
// is not the claim that the flow ran through it. The annotated statement's own
// count (`s`) is measured alongside and printed as an advisory, because moving
// the gate onto it is a decision about the gate. Both readings, what each costs
// and why the level did not move: scripts/README.md (ISS-955).
//
// AUTHORITATIVE vs not: a step reached only by unit tests is reported and does
// not count — 974 vi.mock calls here mean a unit test can enter a step's function
// with every neighbour stubbed out. Only `authoritative` sources settle a step.
//
// Modes: --all (default) · --update-baseline · --require-sources (CI: a missing
// report is a failure, not a skip) · Exit: 0 clean · 1 regressed · 2 could not run

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup, mergeSites, parseSites } from './lib/flow-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');
const BASELINE_PATH = join(ROOT, '.forge', 'flow-coverage-baseline.json');

const DEFAULTS = {
  flows: [],
  sources: [],
};

function die(msg) {
  console.error(`check-flow-coverage: ${msg}`);
  process.exit(2);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) die(`${CONFIG_PATH} not found`);
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...(raw?.checkers?.['flow-coverage'] ?? {}) };
  } catch (err) {
    die(`${CONFIG_PATH} is unreadable — ${err.message}`);
  }
}

// cm:guard the vocabulary lives in the manifest beside this checker's other config, NOT in the source annotations — a flow that exists only because somebody typed `cm:flow x:1` somewhere is a flow nobody declared, and this gate would then measure coverage of whatever was most recently invented rather than of the two paths the repo says it defends.
function declaredFlows(cfg) {
  return (cfg.flows ?? []).map((f) => f.name);
}

// cm:guard the site list is this scan and nothing cross-checks it, so `parseSites` in lib/flow-coverage.mjs is the only thing standing between a malformed annotation and a step silently vanishing from the gate — its 13 unit tests ARE that defence and deleting them un-gates this checker without failing it.
function stepSites(flows) {
  const r = spawnSync('git', ['grep', '-n', '-I', '--', 'cm:flow'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status > 1 || r.error) die('git grep failed — not a checkout?');
  return parseSites(r.stdout, flows);
}

// cm:edge lockstep -> .forge/conformance.json — every entry in `checkers.flow-coverage.sources` declares the `scope` its report claims to measure; a source added there without one fails below rather than being trusted whole
// cm:guard the floor is the scope's last COMMIT time, maxed with working-tree mtimes — neither alone is enough. mtimes alone call every report stale after a `git checkout` moves files whose content is older than the report; commit time alone misses uncommitted edits, which is the state a local `verify` runs in.
/** When the code this report claims to measure last changed, and which file says so. */
function newestSourceChange(scopeRel) {
  const abs = join(ROOT, scopeRel);
  if (!existsSync(abs)) die(`source scope "${scopeRel}" does not exist`);

  const r = spawnSync('git', ['log', '-1', '--format=%ct', '--', scopeRel], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const committed = r.status === 0 && r.stdout.trim() ? Number(r.stdout.trim()) * 1000 : 0;
  let at = committed;
  let what = `${scopeRel} (last commit)`;

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, e.name);
      if (e.isDirectory()) {
        walk(child);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.ts')) continue;
      const m = statSync(child).mtimeMs;
      if (m > at) {
        at = m;
        what = child.slice(ROOT.length + 1);
      }
    }
  };
  walk(abs);
  return { at, what };
}

function loadSource(src) {
  const abs = join(ROOT, src.path);
  if (!existsSync(abs)) return { ...src, missing: true };
  if (!src.scope) die(`source "${src.label}" declares no scope in ${CONFIG_PATH}`);

  // cm:guard a report OLDER than the code it measures must exit 2, never report its rows — this gate reads coverage as evidence a flow step is defended, and a stale report answers for code that no longer exists. Measured 2026-09-06: `verify` was green on "6 settled end-to-end" from a report dated 2026-08-31, taken before the staged lane was deleted. The absent case was already handled by `missing`; the stale case read exactly like a current one.
  const producedAt = statSync(abs).mtimeMs;
  const newest = newestSourceChange(src.scope);
  if (producedAt < newest.at) {
    const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const detail =
      `${src.path} is STALE — produced ${day(producedAt)}, but ${newest.what} changed ` +
      `${day(newest.at)}. It cannot say what today's code covers.\n` +
      `  regenerate: ${src.produce ?? '(no producer declared)'}`;
    // cm:guard stale is unusable evidence either way; only WHERE it is fatal differs. CI produces the report in the same job (ci.yml, `test:integration:coverage` immediately before this), so a stale one there is an anomaly and `--require-sources` fails on it. Locally stale is the NORMAL state — every edit outdates the report — so it degrades to the same skip an absent report takes. Making the local run fatal would mean a 3-minute coverage rebuild before every `verify`, and a gate that expensive gets deleted rather than obeyed.
    if (requireSources) die(detail);
    console.log(`check-flow-coverage: skipped — stale coverage report.\n  ${detail}`);
    return { ...src, missing: true, stale: true };
  }

  try {
    return { ...src, data: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch (err) {
    die(`${src.path} is not readable istanbul JSON — ${err.message}`);
  }
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    die(`${BASELINE_PATH} is unreadable — ${err.message}`);
  }
}

const args = process.argv.slice(2);
const bad = args.filter((a) => !['--all', '--update-baseline', '--require-sources'].includes(a));
if (bad.length) die(`unknown flag: ${bad.join(' ')}`);
const updating = args.includes('--update-baseline');
const requireSources = args.includes('--require-sources');

const cfg = loadConfig();
const flows = declaredFlows(cfg);
if (flows.length === 0)
  die(`checkers.flow-coverage.flows is empty in ${CONFIG_PATH} — nothing this checker can measure`);
if (cfg.sources.length === 0)
  die('checkers.flow-coverage.sources is empty in .forge/conformance.json');

const sites = stepSites(flows);
for (const flow of flows) {
  const found = new Set(sites.get(flow).map((s) => s.step));
  if (found.size === 0)
    die(`flow "${flow}" is declared in ${CONFIG_PATH} but has no cm:flow annotation anywhere`);
}

const sources = cfg.sources.map(loadSource);
const authoritative = sources.filter((s) => s.authoritative);
if (authoritative.length === 0) die('no authoritative coverage source configured');

const missing = sources.filter((s) => s.missing);
if (missing.length === sources.length) {
  const how = missing.map((s) => s.produce ?? s.path).join('\n    ');
  if (requireSources) die(`no coverage report found. Produce one first:\n    ${how}`);
  console.log(
    `check-flow-coverage: skipped — no coverage report on disk. Produce one with:\n    ${how}`,
  );
  process.exit(0);
}

const baseline = loadBaseline();
if (!baseline && !updating)
  die(`${BASELINE_PATH} not found — run with --update-baseline to create it`);
const frozen = new Set(baseline?.uncovered ?? []);

const rows = [];
const uncovered = [];
for (const flow of flows) {
  const byStep = new Map();
  for (const site of sites.get(flow)) {
    const per = sources.map((s) => ({
      label: s.label,
      authoritative: !!s.authoritative,
      ...lookup(s, site),
    }));
    byStep.set(site.step, mergeSites(byStep.get(site.step), per));
  }
  for (const [step, per] of byStep) {
    const scoped = per.filter((p) => p.state === 'outofscope');
    if (scoped.length === per.length) {
      die(
        `${flow}/${step}: not present in ANY coverage report. The step's file is outside the ` +
          'coverage scope, which is a configuration fault, not an uncovered step.',
      );
    }
    // cm:guard `nofn` is a MISPLACED annotation and is refused by name rather than counted as
    // uncovered. `fnHitsAt` resolves a step to the tightest function containing its line, or one
    // declared within 5 lines below; an annotation in a file header belongs to no function and
    // answers `nofn` for every source. Reported as uncovered it read "no test enters it at all" —
    // which sent ISS-1073 to write an integration test that DID enter the function and changed
    // nothing, because the gate was never looking at a function. One CI round trip per reader.
    const unresolved = per.filter((p) => p.state === 'nofn');
    if (unresolved.length === per.length) {
      const where = sites
        .get(flow)
        .filter((s) => s.step === step)
        .map((s) => `${s.file}:${s.line}`)
        .join(', ');
      die(
        `${flow}/${step}: the annotation at ${where} sits inside no function, so no coverage ` +
          'report can say whether it ran. Move the `cm:flow` comment onto the function the step ' +
          'names (the line directly above its declaration), which is where this gate reads it. ' +
          'This is a misplaced annotation, not an uncovered step.',
      );
    }
    const settled = per.some((p) => p.authoritative && p.state === 'covered');
    const unitOnly = !settled && per.some((p) => !p.authoritative && p.state === 'covered');
    const stmtRan = per.some((p) => p.authoritative && p.stmt === 'covered');
    const id = `${flow}/${step}`;
    rows.push({ id, settled, unitOnly, stmtRan, per });
    if (!settled) uncovered.push(id);
  }
}

if (updating) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ uncovered: uncovered.sort() }, null, 2)}\n`);
  console.log(
    `check-flow-coverage: froze ${uncovered.length} uncovered step(s) into ${BASELINE_PATH}`,
  );
  process.exit(0);
}

const w = Math.max(...rows.map((r) => r.id.length), 12);
console.log('');
for (const r of rows) {
  const mark = r.settled ? 'fn:e2e ' : r.unitOnly ? 'fn:unit' : '--     ';
  const detail = r.per
    .filter((p) => p.state === 'covered')
    .map((p) => `${p.label} fn=${p.hits} stmt=${p.stmt === 'covered' ? p.stmtHits : p.stmt}`)
    .join('  ');
  console.log(`  ${mark}  ${r.id.padEnd(w)}  ${detail}`);
}

const fresh = uncovered.filter((id) => !frozen.has(id));
const fixed = [...frozen].filter((id) => !uncovered.includes(id));

const reached = rows.filter((r) => r.settled);
const stmtNever = reached.filter((r) => !r.stmtRan);
// cm:guard the summary names the evidence it READ, and never the phrase "settled end-to-end" — that phrase is what ISS-955 removed, because a reader took it for "the flow ran" when what was measured is one entry into the annotated function
console.log(
  `\ncheck-flow-coverage: ${rows.length} step(s) across ${flows.length} flow(s), ` +
    `${reached.length} reached by the authoritative suite\n` +
    "  evidence: istanbul's per-function invocation count (`f`) — the suite entered the\n" +
    '  annotated function, which is not the same claim as the flow running through it.\n' +
    `  advisory: ${stmtNever.length} of those ${reached.length} never executed their own annotated statement.`,
);
for (const r of stmtNever) console.log(`    fn-only  ${r.id}`);
if (fixed.length)
  console.log(`  ${fixed.length} baselined step(s) now covered — re-freeze with --update-baseline`);

if (fresh.length === 0) process.exit(0);

console.error(
  `\n${fresh.length} flow step(s) named in the map that the authoritative suite never entered:\n`,
);
for (const id of fresh) {
  const r = rows.find((x) => x.id === id);
  const why = r.unitOnly
    ? 'entered only by unit tests — the function runs, the flow does not'
    : 'no test enters it at all';
  console.error(`  ${id}  — ${why}`);
}
console.error(
  '\nA step declared in a flow is a promise that the path is walked. Reach it from the\n' +
    'integration suite, or freeze it with --update-baseline so the debt shows in the diff.\n',
);
process.exit(1);
