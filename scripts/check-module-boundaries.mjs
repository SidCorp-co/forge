#!/usr/bin/env node
// Pattern v2's import rules over packages/core/src (docs/conventions/domain-entities.md, ADR 0008):
// context direction, kind direction, runtime cycles between modules, face-only access, adapters
// reached through their port, and read models SELECTing only the tables they declare under `reads`.
// dependency-cruiser checks the imports with a rule set generated from packages/core/src/modules.json,
// and every violation that already existed is frozen in a shrink-only baseline.
//
// Exits 1 on a declaration fault, a declared read nothing uses, a violation the baseline does not
// hold, a baseline entry that no longer occurs, or a rule whose frozen count rose over the base
// revision; 2 when it cannot run.
// --update-baseline rewrites the baseline to today's violations and refuses to let any rule's
// count rise.
//
//   node scripts/check-module-boundaries.mjs [--update-baseline]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseRev } from './lib/baseline-ratchet.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';
import {
  BOUNDARY_RULES,
  cruiseOptions,
  judge,
  readFindings,
  SRC,
  violationKeys,
} from './lib/module-boundaries.mjs';
import { declaredTables, moduleOf, parseDeclaration } from './lib/module-shape.mjs';

const die = dieAs('module-boundaries');

const DECLARATION = 'packages/core/src/modules.json';
const BASELINE = '.forge/module-boundaries-baseline.json';

const args = process.argv.slice(2);
for (const a of args)
  if (a !== '--update-baseline') die(`unknown argument ${a} — the only flag is --update-baseline`);
const update = args.includes('--update-baseline');

let declaration;
try {
  declaration = JSON.parse(readFileSync(join(ROOT, DECLARATION), 'utf8'));
} catch (err) {
  die(`${DECLARATION} is unreadable: ${err.message}`);
}
const parsed = parseDeclaration(declaration);
if (parsed.faults.length) {
  console.error(`module-boundaries: ${DECLARATION} is refused:\n  ${parsed.faults.join('\n  ')}`);
  process.exit(1);
}
for (const mod of Object.keys(parsed.modules)) {
  if (mod !== '(root)' && !existsSync(join(ROOT, SRC, mod)))
    die(`${DECLARATION} declares ${mod}, which has no directory under ${SRC}`);
}

let cruise;
try {
  ({ cruise } = await import('dependency-cruiser'));
} catch (err) {
  die(`dependency-cruiser does not load (${err.message}); run pnpm install`);
}

const options = cruiseOptions(
  { modules: parsed.modules, contexts: parsed.contexts },
  join(ROOT, 'packages/core/tsconfig.json'),
);
process.chdir(ROOT);
async function run(opts) {
  let output;
  try {
    output = (await cruise([SRC.slice(0, -1)], opts)).output;
  } catch (err) {
    die(`dependency-cruiser failed: ${err.message}`);
  }
  if (!output?.summary || !Array.isArray(output.summary.violations))
    die('dependency-cruiser returned no summary');
  return output;
}
const imports = await run(options.imports);
const cycles = await run(options.cycles);
const files = imports.modules.filter((m) => m.source.startsWith(SRC)).length;
if (files === 0) die(`dependency-cruiser read no file under ${SRC}`);
const current = violationKeys([imports.summary, cycles.summary]);

const sources = imports.modules.filter((m) => m.source.startsWith(SRC));
const text = (f) => readFileSync(join(ROOT, f), 'utf8');
const tables = declaredTables(
  sources
    .filter((m) => /^packages\/core\/src\/db\/schema[^/]*\.ts$/.test(m.source))
    .map((m) => text(m.source)),
);
const { undeclared, unused } = readFindings({
  modules: parsed.modules,
  tables,
  moduleOf: (f) => moduleOf(f, parsed.modules),
  files: new Map(
    sources
      .filter((m) => parsed.modules[moduleOf(m.source, parsed.modules)]?.kind === 'read-model')
      .map((m) => [
        m.source,
        { text: text(m.source), imports: m.dependencies.map((d) => d.resolved) },
      ]),
  ),
});
current['undeclared-read'] = undeclared;
if (unused.length) {
  console.error(`module-boundaries: ${DECLARATION} is refused:\n  ${unused.join('\n  ')}`);
  process.exit(1);
}
const rules = options.imports.ruleSet.forbidden.length + options.cycles.ruleSet.forbidden.length;

function readJson(text, where) {
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${where} is unreadable: ${err.message}`);
  }
}

const baseline = existsSync(join(ROOT, BASELINE))
  ? readJson(readFileSync(join(ROOT, BASELINE), 'utf8'), BASELINE).rules
  : null;

let before = null;
const rev = baseRev(ROOT);
if (!rev && !update)
  die(
    'no base revision to compare the baseline against (a shallow or single-commit checkout); fetch history and re-run',
  );
if (rev) {
  try {
    const text = execFileSync('git', ['show', `${rev}:${BASELINE}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    before = readJson(text, `${BASELINE} at ${rev.slice(0, 9)}`).rules;
  } catch {
    before = null;
  }
}

const counts = (rules) => BOUNDARY_RULES.map((r) => `${r} ${rules?.[r]?.length ?? 0}`).join(' · ');
console.log(
  `module-boundaries: ${files} file(s) cruised, ${imports.summary.totalDependenciesCruised} import(s) (${cycles.summary.totalDependenciesCruised} evaluated at load), ${rules} generated rule(s)`,
);
console.log(`module-boundaries: now      ${counts(current)}`);
console.log(`module-boundaries: baseline ${baseline ? counts(baseline) : 'none'}`);

if (update) {
  const rose = baseline
    ? BOUNDARY_RULES.filter((r) => current[r].length > (baseline[r]?.length ?? 0))
    : [];
  if (rose.length) {
    console.error(
      `module-boundaries: refused — ${rose.map((r) => `${r} ${baseline[r]?.length ?? 0} -> ${current[r].length}`).join(', ')}; the baseline only shrinks, so fix the new violations instead`,
    );
    process.exit(1);
  }
  const doc = {
    $comment:
      'Frozen violations of the import rules scripts/check-module-boundaries.mjs generates from packages/core/src/modules.json, one "<importing file> -> <imported file>" per entry under its rule. Shrink-only: a new violation fails, an entry that no longer occurs fails, and a rule whose count rose over the base revision fails. Rewrite with --update-baseline after fixing violations, never to admit one.',
    rules: current,
  };
  writeFileSync(join(ROOT, BASELINE), `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`module-boundaries: wrote ${BASELINE}`);
  process.exit(0);
}

if (!baseline) die(`${BASELINE} is absent; --update-baseline writes it`);
const { fresh, stale, grown } = judge(current, baseline, before);
const show = (title, list) => {
  if (!list.length) return;
  console.error(`\nmodule-boundaries: ${list.length} ${title}`);
  for (const line of list.slice(0, 50)) console.error(`  ${line}`);
  if (list.length > 50) console.error(`  … and ${list.length - 50} more`);
};
show('new violation(s), not in the baseline — fix the import, never add it to the baseline', fresh);
show('stale baseline entr(y/ies), no longer violated — run --update-baseline to drop them', stale);
show(`rule(s) whose frozen count rose over ${rev?.slice(0, 9) ?? 'the base'}`, grown);
if (fresh.length || stale.length || grown.length) process.exit(1);
console.log('module-boundaries: every violation is frozen and every frozen entry still occurs');
