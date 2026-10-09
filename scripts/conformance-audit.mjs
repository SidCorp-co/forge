#!/usr/bin/env node
// The checker whose SUBJECT is this repo's conformance setup, not its code.
//
// Without it the protocol is content-free: a repo can gate nothing, declare a
// profile, and be perfectly conformant. Every rule below is one that, when
// broken, made a real gate worthless in this repo — R2 and R4 were both live
// defects found by running an earlier draft of this file against its author.
//
// Profiles constrain SHAPE, never tool choice: "two axes blocking" ports to any
// stack, "must run biome" does not.
//
// Exit: 0 meets the claimed profile · 1 does not · 2 cannot audit.
//
// "Does not" and "cannot" are separate accusations and only the first is about
// the repo. R7 is the one rule here that runs a tool, so it is the one that can
// be prevented from answering; when its tool is absent it reports `n/a` and
// takes the script to exit 2 rather than counting as a rule this repo fails.
// Measured 2026-09-07: without that, a worktree missing `node_modules` printed
// `claims "hardened" and does not meet it · 1 rule(s) failing` — an accusation
// against the repo produced entirely by the absence of a binary (ISS-938).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { branchSetFaults, ciBranches, mergeTarget } from './lib/base-branch.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';
import { absentPrerequisites, couldNotStart, remedyLines } from './lib/prerequisite.mjs';
import { CHECKS, CI_PARITY } from './lib/verify-checks.mjs';

const die = dieAs('conformance-audit');

const at = (p) => join(ROOT, p);
const has = (p) => existsSync(at(p));
const read = (p) => {
  try {
    return readFileSync(at(p), 'utf8');
  } catch {
    return null;
  }
};

const PROFILES = {
  baseline: { blurb: 'a number you did not have', at1: 1, at2: 0, ci: false, meta: false },
  standard: {
    blurb: 'debt stops growing, gates cannot rot silently',
    at1: 2,
    at2: 2,
    ci: true,
    meta: true,
  },
  hardened: {
    blurb: 'the whole declared surface is defended',
    at1: 4,
    at2: 4,
    ci: true,
    meta: true,
  },
};

const IMPROVES = ['down', 'shrink', 'tighten'];

let manifest;
try {
  manifest = JSON.parse(read('.forge/conformance.json') ?? '');
} catch {
  die('.forge/conformance.json is missing or unreadable — nothing to audit');
}
const axes = manifest.axes ?? {};
const claimed = manifest.profile ?? null;
if (Object.keys(axes).length === 0)
  die('the manifest declares no axis — an audit over an empty set is not a pass');

const declaredChecks = [...CHECKS, CI_PARITY];
const labels = declaredChecks.map((c) => c.label);
const proven = declaredChecks.filter((c) => c.scanned instanceof RegExp).map((c) => c.label);
const unproven = labels.filter((l) => !proven.includes(l));

const CI_DIR = '.github/workflows';
const ciText = has(CI_DIR)
  ? readdirSync(at(CI_DIR))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => read(`${CI_DIR}/${f}`))
      .join('\n')
  : (read('.gitlab-ci.yml') ?? '');
const hasCI = ciText.length > 0;

/** ci-passed's `needs`, written as a flow list (`[a, b]`) or a block list (`- a` lines); null when
 *  there is no ci-passed job or its needs cannot be read, which R4 refuses rather than reading as none. */
function ciPassedNeeds(text) {
  const job = /^( *)ci-passed:\s*\n((?:\1 +.*\n?|\s*\n)*)/m.exec(text);
  if (!job) return null;
  const flow = /^\s*needs:\s*\[([^\]]*)\]/m.exec(job[2]);
  if (flow)
    return flow[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const block = /^( *)needs:\s*\n((?:\1 +- .*\n?)+)/m.exec(job[2]);
  if (block) return [...block[2].matchAll(/- *([^\s#]+)/g)].map((m) => m[1]);
  return null;
}
const needs = ciPassedNeeds(ciText);
const asserted = [...ciText.matchAll(/"([a-z0-9-]+):\$\{\{\s*needs\.[a-z0-9-]+\.result/g)].map(
  (m) => m[1],
);
const unasserted = (needs ?? []).filter((j) => j !== 'changes' && !asserted.includes(j));

const badBaselines = [];
for (const [name, spec] of Object.entries(axes)) {
  if ((spec.level ?? 0) !== 2) continue;
  if (spec.baseline === undefined) {
    badBaselines.push([name, 'level 2 with no baseline declared']);
    continue;
  }
  for (const [slot, b] of [
    ['baseline', spec.baseline],
    ['alsoBaseline', spec.alsoBaseline],
  ]) {
    if (b === undefined) continue;
    if (b === null) badBaselines.push([name, `${slot} is null at level 2 — nothing is frozen`]);
    else if (!b.path) badBaselines.push([name, `${slot} has no path`]);
    else if (!has(b.path)) badBaselines.push([name, `${b.path} declared but absent`]);
    else if (!IMPROVES.includes(b.improves)) {
      badBaselines.push([
        name,
        `${b.path} declares improves=${b.improves ?? 'nothing'}, not one of ${IMPROVES.join('/')}`,
      ]);
    }
  }
}

const unfailable = [...ciText.matchAll(/continue-on-error:\s*true/g)].length;

// R11's subject is one workflow, not every one of them: the promotion workflows fire on `main`
// alone on purpose, and folding them into `ciText` would make the rule accuse them of it.
const ciYml = read('.github/workflows/ci.yml');
const target = mergeTarget(ROOT).branch ?? null;
const branchFaults = ciYml === null ? null : branchSetFaults(ciYml, target);
const gatedBranches = ciYml === null ? null : (ciBranches(ciYml).push ?? []).join(', ');

/** Every top-level job key under `jobs:` in one workflow's text. */
function workflowJobs(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) jobs.push(head[1]);
  }
  return jobs;
}

/**
 * The whole suite blocks something — the release cut — so, like an axis, it declares which axis
 * owns it and at what level. `$postMerge` blocks nothing and names no axis: its jobs belong to
 * several or none.
 */
function wholeSuiteOwnerFaults(declared, declaredAxes) {
  if (!declared) return [];
  const faults = [];
  if (!(declared.axis in declaredAxes)) {
    faults.push(
      `$wholeSuite.axis: ${JSON.stringify(declared.axis ?? null)} is none of the axes (${Object.keys(declaredAxes).join(', ')})`,
    );
  }
  if (!Number.isInteger(declared.level) || declared.level < 1 || declared.level > 3) {
    faults.push(`$wholeSuite.level: ${JSON.stringify(declared.level ?? null)} is not a level 1-3`);
  }
  return faults;
}

// R12: every ci.yml job gates the merge, runs after it, or judges the whole suite — exactly one.
const postMerge = manifest.$postMerge?.jobs ?? [];
const wholeSuite = manifest.$wholeSuite?.jobs ?? [];
const ciJobs = ciYml === null ? null : workflowJobs(ciYml);
const gateNeeds = ciPassedNeeds(ciYml ?? '') ?? [];
const classes = [
  ['ci-passed.needs', gateNeeds],
  ['$postMerge.jobs', postMerge],
  ['$wholeSuite.jobs', wholeSuite],
];
const partitionFaults =
  ciJobs === null
    ? null
    : [
        ...ciJobs
          .filter((j) => j !== 'ci-passed' && !classes.some(([, jobs]) => jobs.includes(j)))
          .map((j) => `${j}: in none of ${classes.map(([name]) => name).join(', ')}`),
        ...ciJobs.flatMap((j) => {
          const held = classes.filter(([, jobs]) => jobs.includes(j)).map(([name]) => name);
          return held.length > 1 ? [`${j}: in ${held.join(' and in ')}`] : [];
        }),
        ...[
          ...postMerge.map((j) => ['$postMerge.jobs', j]),
          ...wholeSuite.map((j) => ['$wholeSuite.jobs', j]),
        ]
          .filter(([, j]) => !ciJobs.includes(j))
          .map(([name, j]) => `${j}: in ${name} and no such job in ci.yml`),
        ...wholeSuiteOwnerFaults(manifest.$wholeSuite, axes),
      ];

const NON_BLOCKING = new Set(['warn', 'info', 'on']);

/** Every rule a biome config sets to a severity biome exits 0 on, as biome category ids. */
function nonBlockingRules(doc) {
  const out = new Set();
  const walk = (rules) => {
    for (const [group, body] of Object.entries(rules ?? {})) {
      if (group === 'preset' || group === 'recommended') continue;
      if (typeof body === 'string') {
        if (NON_BLOCKING.has(body)) out.add(`lint/${group}/*`);
        continue;
      }
      for (const [name, spec] of Object.entries(body ?? {})) {
        if (NON_BLOCKING.has(typeof spec === 'string' ? spec : spec?.level)) {
          out.add(`lint/${group}/${name}`);
        }
      }
    }
  };
  walk(doc?.linter?.rules);
  for (const o of doc?.overrides ?? []) walk(o?.linter?.rules);
  return out;
}

function biomeConfigs(dir = '', depth = 0, acc = []) {
  if (depth > 3) return acc;
  for (const e of readdirSync(at(dir), { withFileTypes: true })) {
    if (e.name.startsWith('.') || ['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) biomeConfigs(p, depth + 1, acc);
    else if (e.name === 'biome.json') acc.push(p);
  }
  return acc;
}

function nonBlockingDeclared() {
  const gaps = [];
  for (const cfg of biomeConfigs()) {
    const dir = dirname(cfg) === '.' ? '' : dirname(cfg);
    let doc;
    try {
      doc = JSON.parse(read(cfg) ?? '');
    } catch {
      gaps.push(`${cfg} is unreadable`);
      continue;
    }
    for (const rule of nonBlockingRules(doc)) gaps.push(`${dir || '.'} ${rule}`);
  }
  return gaps;
}

const uncounted = nonBlockingDeclared();

const notBlocking = Object.entries(axes)
  .filter(([, s]) => !(typeof s?.level === 'number' && s.level >= 2))
  .map(([a, s]) => `${a} (level ${JSON.stringify(s?.level) ?? 'absent'})`);

const overclaimed = Object.entries(axes)
  .filter(([, s]) => (s.level ?? 0) > 1 && !hasCI)
  .map(([a]) => a);

const metaStatus =
  CHECKS.some((c) => c.label === 'conformance levels') || /conformance-status/.test(ciText);
const metaParity = CI_PARITY.label === 'ci-parity' || /ci-parity/.test(ciText);
const lvl = (n) => Object.values(axes).filter((s) => (s.level ?? 0) >= n).length;

function unresolvableEdges() {
  const declared = manifest?.checkers?.archmap?.maxUnresolvableEdges;
  if (typeof declared !== 'number') return { declared: null };
  const missing = absentPrerequisites(ROOT, [
    'deps',
    'archmap-resolver',
    'observability-build',
    'contracts-build',
  ]);
  if (missing.length > 0) return { declared, blocked: remedyLines(missing)[0] };
  const r = spawnSync(at('.forge/archmap/archmap'), ['check', '--stats'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (couldNotStart(r))
    return { declared, blocked: '.forge/archmap/archmap is not executable here' };
  const m = /(\d+)\s+unresolvable(?:\s+of\s+\d+\s+possible)?\s+edges/.exec(r.stdout ?? '');
  if (m) return { declared, measured: Number(m[1]) };
  if (r.signal || r.status !== 0) {
    const how = r.signal ? `was killed by ${r.signal}` : `exited ${r.status}`;
    const said = (r.stderr ?? '').trim().split('\n').pop() ?? '';
    return {
      declared,
      blocked: `archmap check --stats ${how} before printing a count${said ? ` — ${said.slice(0, 120)}` : ''}`,
    };
  }
  return { declared, measured: null };
}

const resolution = unresolvableEdges();

const RULES = [
  {
    id: 'R1',
    text: 'an entrypoint exists — one command runs every check',
    pass: labels.length > 0,
    detail: labels.length
      ? `scripts/lib/verify-checks.mjs, ${labels.length} checks`
      : 'scripts/lib/verify-checks.mjs declares no check',
    why: 'a rule with no command to run it is not a rule; this repo had none for months',
  },
  {
    id: 'R2',
    text: 'every declared check proves it scanned something',
    pass: unproven.length === 0,
    detail: unproven.length
      ? `no scan proof: ${unproven.join(', ')}`
      : `${proven.length}/${labels.length} prove scan`,
    why: '"0 violations" and "I looked at nothing" print identically without a count',
  },
  {
    id: 'R3',
    text: 'every level-2 axis has a baseline that declares its direction',
    pass: badBaselines.length === 0,
    detail: badBaselines.length
      ? badBaselines.map(([a, m]) => `${a}: ${m}`).join(' · ')
      : 'all declare path + improves',
    why: 'without a direction a baseline cannot be compared — it is only a photograph',
  },
  {
    id: 'R4',
    text: 'every job the merge gate needs is also asserted by it',
    pass: hasCI ? needs !== null && needs.length > 0 && unasserted.length === 0 : null,
    detail: !hasCI
      ? 'no CI'
      : needs === null || needs.length === 0
        ? 'no ci-passed job with a readable needs list, so no job it gates is checked'
        : unasserted.length
          ? `listed, never asserted: ${unasserted.join(', ')}`
          : `${needs.length} jobs, all asserted`,
    why: 'ci-passed runs if:always() — a listed-but-unasserted job cannot fail the gate',
  },
  {
    id: 'R5',
    text: 'both meta-checks are present',
    pass: metaStatus && metaParity,
    detail: `status:${metaStatus ? 'yes' : 'NO'} parity:${metaParity ? 'yes' : 'NO'}`,
    why: 'three gates here stopped gating within two days; only meta-checks caught it',
  },
  {
    id: 'R6',
    text: 'no axis declares a blocking level without CI to block with',
    pass: overclaimed.length === 0,
    detail: overclaimed.length ? `level > 1 with no CI: ${overclaimed.join(', ')}` : 'no overclaim',
    why: 'a level that claims to block, where nothing blocks, is the lie this system exists to catch',
  },
  {
    id: 'R7',
    text: 'the relations gate can resolve the graph it claims to cover',
    blocked: resolution.blocked ?? null,
    pass:
      resolution.declared === null || resolution.blocked
        ? null
        : resolution.measured !== null && resolution.measured <= resolution.declared,
    detail: resolution.blocked
      ? `could not run — ${resolution.blocked}`
      : resolution.declared === null
        ? 'no checkers.archmap.maxUnresolvableEdges declared'
        : resolution.measured === null
          ? 'archmap check --stats printed no unresolvable count'
          : `${resolution.measured} unresolvable (ceiling ${resolution.declared})`,
    why: 'an unresolvable edge is dropped, not reported — a gate that resolves nothing prints the same "0 violations" a clean repo does',
  },
  {
    id: 'R8',
    text: 'no CI step runs where it cannot fail',
    pass: hasCI ? unfailable === 0 : null,
    detail: !hasCI ? 'no CI' : `${unfailable} step(s) with continue-on-error: true`,
    why: 'a check that runs and cannot fail is stage 0 — it produces a number nobody is held to, which is how the desktop Rust gate drifted behind a comment promising cleanup',
  },
  {
    id: 'R9',
    text: 'no biome config declares a rule at a severity biome exits 0 on',
    pass: uncounted.length === 0,
    detail: uncounted.length
      ? `non-blocking: ${uncounted.join(' · ')}`
      : 'every declared rule is `error`; rules left non-blocking by preset default are not read',
    why: 'biome exits 0 on a warning and on an info, so such a rule is a signal produced and discarded — packages/core carried 280 of them through a hardened profile with ten gates over it, invisible to all seven rules above because every one judges a DECLARED axis. No rule has a baseline counting it since the size ratchet was retired, so every declared rule is `error` or it fails here. The bound is real: this reads the config, so a package whose biome.json is only `{"recommended": true}` passes it while carrying preset-default warn/info debt',
  },
  {
    id: 'R10',
    text: 'every declared axis declares a numeric level of at least 2',
    pass: notBlocking.length === 0,
    detail: notBlocking.length
      ? `not blocking: ${notBlocking.join(' · ')}`
      : `${Object.keys(axes).length} axes, all at level >= 2`,
    why: 'levels 0 and 1 both mean "produces a number nobody is held to", which is where every gate this repo lost was standing while documented as blocking; R1-R9 skip any axis that is not level 2, so without this an axis could declare 1 — or omit the key, or quote the digit — and pass the whole audit',
  },
  {
    id: 'R11',
    text: 'one branch set across the merge gate, and the merge target is in it',
    pass: branchFaults === null ? null : branchFaults.length === 0,
    detail:
      branchFaults === null
        ? 'no .github/workflows/ci.yml'
        : branchFaults.length > 0
          ? branchFaults.join(' · ')
          : `${gatedBranches || '(none)'}, in all three${target ? `, merge target ${target} among them` : ' (no merge target here to check them against)'}`,
    why: 'a workflow trigger cannot read a variable, so the branches CI gates are written three times over — the push trigger, the pull-request trigger, and the step that decides a tree a pull request already proved. A branch in one list and not the others is a pull request that runs no CI at all, or a whole gate re-run on every merge into it, and the first of those reports nothing: a pull request with no CI shows no failure, only an absence nobody is looking at. Three lists that agree on a set the merge target is not in are consistent and gate nothing, which is the same absence reached from the other side (ISS-1304)',
  },
  {
    id: 'R12',
    text: 'every CI job gates the merge, runs after it, or judges the whole suite, and is exactly one',
    pass: partitionFaults === null ? null : partitionFaults.length === 0,
    detail:
      partitionFaults === null
        ? 'no .github/workflows/ci.yml'
        : partitionFaults.length > 0
          ? partitionFaults.join(' · ')
          : `${gateNeeds.length} gate the merge, ${postMerge.length} run after it${postMerge.length ? ` (${postMerge.join(', ')}, ${manifest.$postMerge.issue ?? 'no issue named'})` : ''}, ${wholeSuite.length} judge the whole suite${wholeSuite.length ? ` (${wholeSuite.join(', ')}, ${manifest.$wholeSuite.issue ?? 'no issue named'})` : ''}`,
    why: 'a job left out of ci-passed.needs blocks nothing and says so nowhere: its red shows on a run nobody is required to read. ISS-1370 moved four jobs after the merge on purpose, and .forge/conformance.json $postMerge is where that is priced; ISS-471 added three that run only in a whole-suite run, declared in $wholeSuite, which blocks the release cut and so names its axis and level as an axis does; a job in none of the lists was placed by nobody, and one in two is a declaration that no longer describes the gate',
  },
];

let failed = 0;
let blocked = 0;
console.log(
  `\n  axes ${Object.keys(axes).length}   level>=1 ${lvl(1)}   level>=2 ${lvl(2)}   CI ${hasCI ? 'yes' : 'none'}   profile ${claimed ?? 'undeclared'}\n`,
);
for (const r of RULES) {
  const mark = r.blocked ? 'n/a ' : r.pass === null ? ' -- ' : r.pass ? '  ok' : 'FAIL';
  if (r.pass === false) failed++;
  if (r.blocked) blocked++;
  console.log(`  ${mark}  ${r.id}  ${r.text}`);
  console.log(`        ${r.detail}`);
  if (r.pass === false) console.log(`        why: ${r.why}`);
}

function shortfall(name) {
  const p = PROFILES[name];
  const miss = [];
  if (lvl(1) < p.at1) miss.push(`needs ${p.at1} axis/axes at level>=1, has ${lvl(1)}`);
  if (lvl(2) < p.at2) miss.push(`needs ${p.at2} at level>=2, has ${lvl(2)}`);
  if (p.ci && !hasCI) miss.push('needs CI that can block a merge');
  if (p.meta && !(metaStatus && metaParity)) miss.push('needs both meta-checks');
  if (failed > 0) miss.push(`${failed} rule(s) failing`);
  return miss;
}

console.log(`\nconformance-audit: ${RULES.length} rules evaluated`);

if (blocked > 0) {
  console.error(
    `\nconformance-audit: ${blocked} rule(s) could not be evaluated — the tool they run gave\n` +
      'no measurement. No claim is made about the profile either way: a rule that did not run\n' +
      'is not a rule this repo fails. Each line below says which tool and why. Exit 2.\n',
  );
  for (const r of RULES.filter((x) => x.blocked)) console.error(`  ${r.id}: ${r.blocked}`);
  console.error('');
  process.exit(2);
}

if (!claimed) {
  const best = Object.keys(PROFILES)
    .filter((n) => shortfall(n).length === 0)
    .pop();
  console.log(
    `\nNo profile declared. Add "profile": "${best ?? 'baseline'}" to .forge/conformance.json`,
  );
  console.log('so the claim is one somebody else can fail you on.\n');
  process.exit(failed > 0 ? 1 : 0);
}
if (!PROFILES[claimed])
  die(`unknown profile "${claimed}" — one of ${Object.keys(PROFILES).join(', ')}`);

const miss = shortfall(claimed);
if (miss.length === 0) {
  console.log(
    `\nconformance: meets the "${claimed}" profile it claims — ${PROFILES[claimed].blurb}\n`,
  );
  process.exit(0);
}
console.error(`\nconformance: claims "${claimed}" and does not meet it`);
for (const m of miss) console.error(`  · ${m}`);
console.error(
  '\nFix the setup or lower the claim. A profile you do not meet is the same\ndefect as a gate you do not have.\n',
);
process.exit(1);
