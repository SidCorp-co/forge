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

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIZE_RULES } from './lib/lint-budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(ROOT, p);
const has = (p) => existsSync(at(p));
const read = (p) => {
  try {
    return readFileSync(at(p), 'utf8');
  } catch {
    return null;
  }
};

// cm:guard a profile bounds SHAPE only — axis counts, CI, meta-checks. The moment one names a tool, the claim stops porting across stacks and this file becomes a second place that decides which linter a repo runs.
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

function die(message) {
  console.error(`conformance-audit: ${message}`);
  process.exit(2);
}

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

const verifySrc = read('scripts/verify.mjs') ?? '';
const labels = [...verifySrc.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
const proven = [...verifySrc.matchAll(/label:\s*'([^']+)'[\s\S]{0,400}?scanned:/g)].map(
  (m) => m[1],
);
const unproven = labels.filter((l) => !proven.includes(l));

const CI_DIR = '.github/workflows';
const ciText = has(CI_DIR)
  ? readdirSync(at(CI_DIR))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => read(`${CI_DIR}/${f}`))
      .join('\n')
  : (read('.gitlab-ci.yml') ?? '');
const hasCI = ciText.length > 0;

const needsM = /ci-passed:[\s\S]*?needs:\s*\[([^\]]*)\]/.exec(ciText);
const needs = needsM
  ? needsM[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const asserted = [...ciText.matchAll(/"([a-z0-9-]+):\$\{\{\s*needs\.[a-z0-9-]+\.result/g)].map(
  (m) => m[1],
);
const unasserted = needs.filter((j) => j !== 'changes' && !asserted.includes(j));

const badBaselines = [];
// cm:guard judge EVERY declared baseline, `alsoBaseline` included. This loop read only `spec.baseline` from the day it landed, so 3 of the 6 baselines the manifest declares were never audited for a direction — the identical hole conformance-status.mjs closed for itself, in the one check whose whole subject is whether the setup does what it claims.
for (const [name, spec] of Object.entries(axes)) {
  // cm:why level 3 means zero violations and NO baseline, so an absent one is the point rather than a fault — auditing it would punish the strictest level
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

// cm:guard a step that runs and cannot fail is stage 0 by construction — the ONE configuration this repo has measured failing. `continue-on-error: true` carried the desktop Rust gate for months next to a comment promising cleanup "as a separate ISS"; the drift ended when the package was deleted, not when the debt was paid. Zero across .github/workflows/ on 2026-08-27, which is the one day freezing it costs nothing.
const unfailable = [...ciText.matchAll(/continue-on-error:\s*true/g)].length;

/** Every rule in a biome config set to `warn`, as biome category ids. */
function warnRules(doc) {
  const out = new Set();
  const walk = (rules) => {
    for (const [group, body] of Object.entries(rules ?? {})) {
      // cm:why `preset` and `recommended` name a rule SET, not a rule, so a severity read off them would be a category id no diagnostic ever carries
      if (group === 'preset' || group === 'recommended') continue;
      if (typeof body === 'string') {
        if (body === 'warn') out.add(`lint/${group}/*`);
        continue;
      }
      for (const [name, spec] of Object.entries(body ?? {})) {
        if ((typeof spec === 'string' ? spec : spec?.level) === 'warn') {
          out.add(`lint/${group}/${name}`);
        }
      }
    }
  };
  walk(doc?.linter?.rules);
  // cm:guard walk `overrides` too. packages/core drops `noUnsafeOptionalChaining` to `warn` there for 43 test-file sites, and a scan of the top-level rules alone would report that config fully covered while an entire severity downgrade went uncounted.
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

// cm:guard the checker that OWNS a rule decides which baseline must count it: the two length rules are frozen by line count in .forge/size-baseline.json, everything else per (file, rule) in .forge/lint-baseline.json. Reading both scope lists from the manifest rather than restating them is what makes registering a scope enough to satisfy this rule.
function uncountedWarnRules() {
  const scopesOf = (key) =>
    (manifest?.checkers?.[key]?.scopes ?? []).map((s) => s.cwd).filter(Boolean);
  const lint = scopesOf('lint-budget');
  const size = scopesOf('size-budget');
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
    for (const rule of warnRules(doc)) {
      if (!(SIZE_RULES.has(rule) ? size : lint).includes(dir)) gaps.push(`${dir || '.'} ${rule}`);
    }
  }
  return gaps;
}

const uncounted = uncountedWarnRules();

const overclaimed = Object.entries(axes)
  .filter(([, s]) => (s.level ?? 0) > 1 && !hasCI)
  .map(([a]) => a);

const metaStatus = /conformance-status/.test(verifySrc) || /conformance-status/.test(ciText);
const metaParity = /ci-parity/.test(verifySrc) || /ci-parity/.test(ciText);
const lvl = (n) => Object.values(axes).filter((s) => (s.level ?? 0) >= n).length;

// cm:guard R7 is the only rule here that RUNS anything, and it has to: whether the relations gate can resolve the graph it covers is knowable only by asking it, and a gate that resolves nothing prints the same "0 violations" a clean repo does. Measured 2026-08-23: `archmap check` could not follow web-v2's `@/*` alias, 841 of 997 edges were dropped, and three contracts over that package would have locked onto an empty graph.
function unresolvableEdges() {
  const declared = manifest?.checkers?.archmap?.maxUnresolvableEdges;
  if (typeof declared !== 'number') return { declared: null };
  const r = spawnSync(at('.forge/archmap/archmap'), ['check', '--stats'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // cm:guard match BOTH phrasings archmap has printed — `N unresolvable edges` (<=0.1.2) and `N unresolvable of M possible edges` (0.1.3+). A regex that stops matching yields measured:null, which FAILS this rule rather than passing it, so a wording change is loud rather than silent — but it also fails a repo whose gate is fine, which is why the pattern must track the tool.
  const m = /(\d+)\s+unresolvable(?:\s+of\s+\d+\s+possible)?\s+edges/.exec(r.stdout ?? '');
  return { declared, measured: m ? Number(m[1]) : null };
}

const resolution = unresolvableEdges();

const RULES = [
  {
    id: 'R1',
    text: 'an entrypoint exists — one command runs every check',
    pass: labels.length > 0,
    detail: labels.length
      ? `scripts/verify.mjs, ${labels.length} checks`
      : 'no scripts/verify.mjs, or it declares no check',
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
    pass: hasCI ? unasserted.length === 0 : null,
    detail: !hasCI
      ? 'no CI'
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
    pass:
      resolution.declared === null
        ? null
        : resolution.measured !== null && resolution.measured <= resolution.declared,
    detail:
      resolution.declared === null
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
    text: 'every lint rule at a non-blocking severity is counted by a baselined checker',
    pass: uncounted.length === 0,
    detail: uncounted.length
      ? `uncounted: ${uncounted.join(' · ')}`
      : 'every warn-severity rule is frozen somewhere',
    why: 'biome exits 0 on a warning, so a `warn` rule no baseline counts is a signal produced and discarded — packages/core carried 280 of them through a hardened profile with ten gates over it, invisible to all seven rules above because every one judges a DECLARED axis',
  },
];

let failed = 0;
console.log(
  `\n  axes ${Object.keys(axes).length}   level>=1 ${lvl(1)}   level>=2 ${lvl(2)}   CI ${hasCI ? 'yes' : 'none'}   profile ${claimed ?? 'undeclared'}\n`,
);
for (const r of RULES) {
  const mark = r.pass === null ? ' -- ' : r.pass ? '  ok' : 'FAIL';
  if (r.pass === false) failed++;
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
