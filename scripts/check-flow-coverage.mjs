#!/usr/bin/env node
// Every declared cm:flow step must be executed by the end-to-end suite.
//
// This is the join between the knowledge axis and the behaviour axis. codemap
// says "this line is step 4 of the dispatch flow"; coverage says which lines a
// test actually ran. A step named in the map and executed by nothing is a step
// the next editor believes is defended.
//
// It is measured, never declared. A test file cannot claim to cover a flow —
// the claim would be exactly what conformance-status.mjs exists to catch. The
// only evidence accepted here is an istanbul-shaped coverage report.
//
// AUTHORITATIVE vs not: a step reached only by unit tests is reported but does
// not count. 974 vi.mock calls in this repo mean a unit test can execute a
// step's function with every neighbour stubbed out — which proves the function
// runs, not that the flow connects. Only sources marked authoritative in
// .forge/conformance.json (the integration suite) settle a step.
//
// Modes: --all (default) · --update-baseline · --require-sources (CI: a missing
// coverage report is a failure, not a skip)
// Exit: 0 clean · 1 a step regressed to uncovered · 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');
const BASELINE_PATH = join(ROOT, '.forge', 'flow-coverage-baseline.json');

const DEFAULTS = {
  cm: '.forge/codemap/cm',
  codemapConfig: '.forge/codemap.json',
  sources: [],
};

const FLOW_RE = /cm:flow\s+([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/;

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

function declaredFlows(cfg) {
  const p = join(ROOT, cfg.codemapConfig);
  if (!existsSync(p)) die(`${cfg.codemapConfig} not found — codemap owns the flow vocabulary`);
  try {
    return (JSON.parse(readFileSync(p, 'utf8')).flows ?? []).map((f) => f.name);
  } catch (err) {
    die(`${cfg.codemapConfig} is unreadable — ${err.message}`);
  }
}

// cm:guard the site list comes from grep but the COUNT comes from `cm flow`, and a disagreement exits 2 — parsing annotations here duplicates codemap's parser, so the only safe way to keep the copy is to make the tool audit it every run
function stepSites(flows) {
  const r = spawnSync('git', ['grep', '-n', '-I', '--', 'cm:flow'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status > 1 || r.error) die('git grep failed — not a checkout?');
  const byFlow = new Map(flows.map((f) => [f, []]));
  for (const line of (r.stdout ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const file = line.slice(0, at);
    const rest = line.slice(at + 1);
    const at2 = rest.indexOf(':');
    if (at2 < 0) continue;
    const lineNo = Number(rest.slice(0, at2));
    const m = FLOW_RE.exec(rest.slice(at2 + 1));
    if (!m || !Number.isFinite(lineNo)) continue;
    if (!byFlow.has(m[1])) continue;
    byFlow.get(m[1]).push({ flow: m[1], step: m[2], file, line: lineNo });
  }
  return byFlow;
}

function toolStepCount(cfg, flow) {
  const r = spawnSync(cfg.cm, ['flow', flow], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const seen = new Set();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s+(\S+)\s{2,}\S+:\d+\s*$/.exec(line);
    if (m) seen.add(m[1]);
  }
  return seen.size;
}

function loadSource(src) {
  const abs = join(ROOT, src.path);
  if (!existsSync(abs)) return { ...src, missing: true };
  try {
    return { ...src, data: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch (err) {
    die(`${src.path} is not readable istanbul JSON — ${err.message}`);
  }
}

// cm:why a cm:flow annotation sits on a comment line ABOVE the code it names, so the step's line falls just outside its own function — hence the tightest containing function, or failing that one declared within 5 lines below
function hitsAt(entry, line) {
  let best = null;
  for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
    const start = fn.decl?.start?.line ?? fn.loc?.start?.line;
    const end = fn.loc?.end?.line;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start > line + 5 || end < line) continue;
    if (!best || end - start < best.span)
      best = { span: end - start, hits: entry.f?.[id] ?? 0, name: fn.name };
  }
  return best;
}

function lookup(source, site) {
  if (source.missing) return { state: 'nosource' };
  const suffix = `/${site.file}`;
  const key = Object.keys(source.data).find(
    (k) => k.endsWith(suffix) || k.endsWith(suffix.replace(/^\/packages\/[^/]+\//, '/')),
  );
  if (!key) return { state: 'outofscope' };
  const fn = hitsAt(source.data[key], site.line);
  if (!fn) return { state: 'nofn' };
  return { state: fn.hits > 0 ? 'covered' : 'uncovered', hits: fn.hits, fn: fn.name };
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
if (flows.length === 0) die('no flows declared in codemap — nothing this checker can measure');
if (cfg.sources.length === 0)
  die('checkers.flow-coverage.sources is empty in .forge/conformance.json');

const sites = stepSites(flows);
for (const flow of flows) {
  const found = new Set(sites.get(flow).map((s) => s.step));
  if (found.size === 0)
    die(`flow "${flow}" is declared in codemap but has no cm:flow annotation anywhere`);
  const claimed = toolStepCount(cfg, flow);
  if (claimed === null) die(`\`cm flow ${flow}\` failed — cannot audit the step list`);
  if (claimed !== found.size) {
    die(
      `flow "${flow}": cm reports ${claimed} step(s), this scan found ${found.size}. ` +
        'The annotation scan and codemap disagree; trust codemap and fix the scan.',
    );
  }
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
    const prev = byStep.get(site.step);
    const merged = prev ? prev.map((p, i) => (p.state === 'covered' ? p : per[i])) : per;
    byStep.set(site.step, merged);
  }
  for (const [step, per] of byStep) {
    const scoped = per.filter((p) => p.state === 'outofscope');
    if (scoped.length === per.length) {
      die(
        `${flow}/${step}: not present in ANY coverage report. The step's file is outside the ` +
          'coverage scope, which is a configuration fault, not an uncovered step.',
      );
    }
    const settled = per.some((p) => p.authoritative && p.state === 'covered');
    const unitOnly = !settled && per.some((p) => !p.authoritative && p.state === 'covered');
    const id = `${flow}/${step}`;
    rows.push({ id, settled, unitOnly, per });
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
  const mark = r.settled ? 'e2e ' : r.unitOnly ? 'UNIT' : '--  ';
  const detail = r.per
    .filter((p) => p.state === 'covered')
    .map((p) => `${p.label}=${p.hits}`)
    .join(' ');
  console.log(`  ${mark}  ${r.id.padEnd(w)}  ${detail}`);
}

const fresh = uncovered.filter((id) => !frozen.has(id));
const fixed = [...frozen].filter((id) => !uncovered.includes(id));

console.log(
  `\ncheck-flow-coverage: ${rows.length} step(s) across ${flows.length} flow(s), ` +
    `${rows.filter((r) => r.settled).length} settled end-to-end`,
);
if (fixed.length)
  console.log(`  ${fixed.length} baselined step(s) now covered — re-freeze with --update-baseline`);

if (fresh.length === 0) process.exit(0);

console.error(
  `\n${fresh.length} flow step(s) named in the map but executed by no end-to-end test:\n`,
);
for (const id of fresh) {
  const r = rows.find((x) => x.id === id);
  const why = r.unitOnly
    ? 'reached only by unit tests — the function runs, the flow does not'
    : 'no test executes it at all';
  console.error(`  ${id}  — ${why}`);
}
console.error(
  '\nA step declared in a flow is a promise that the path is walked. Cover it with an\n' +
    'end-to-end test, or freeze it with --update-baseline so the debt shows in the diff.\n',
);
process.exit(1);
