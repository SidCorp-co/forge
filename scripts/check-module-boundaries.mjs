#!/usr/bin/env node
// Pattern v2's import rules over packages/core/src (docs/patterns/core-module.md, ADR 0008):
// context direction, kind direction, runtime cycles between modules, face-only access, adapters
// reached through their port, and read models SELECTing only the tables they declare under `reads`.
// dependency-cruiser checks the imports with a rule set generated from packages/core/src/modules.json.
// Nothing is frozen: every rule is at zero, so any violation fails.
//
// Exits 1 on a declaration fault, a declared read nothing uses, or any violation; 2 when it cannot
// run.
//
//   node scripts/check-module-boundaries.mjs

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dieAs, ROOT } from './lib/gate.mjs';
import {
  BOUNDARY_RULES,
  cruiseOptions,
  readFindings,
  SRC,
  violationKeys,
} from './lib/module-boundaries.mjs';
import { declaredTables, moduleOf, parseDeclaration } from './lib/module-shape.mjs';

const die = dieAs('module-boundaries');

const DECLARATION = 'packages/core/src/modules.json';

const args = process.argv.slice(2);
if (args.length) die(`unknown argument ${args[0]} — this checker takes none`);

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

const counts = (rules) => BOUNDARY_RULES.map((r) => `${r} ${rules?.[r]?.length ?? 0}`).join(' · ');
console.log(
  `module-boundaries: ${files} file(s) cruised, ${imports.summary.totalDependenciesCruised} import(s) (${cycles.summary.totalDependenciesCruised} evaluated at load), ${rules} generated rule(s)`,
);
console.log(`module-boundaries: now ${counts(current)}`);

const violations = BOUNDARY_RULES.flatMap((r) => (current[r] ?? []).map((k) => `${r}: ${k}`));
if (violations.length) {
  console.error(
    `\nmodule-boundaries: ${violations.length} violation(s) — fix the import; nothing can freeze one`,
  );
  for (const line of violations.slice(0, 50)) console.error(`  ${line}`);
  if (violations.length > 50) console.error(`  … and ${violations.length - 50} more`);
  process.exit(1);
}
console.log('module-boundaries: no violation');
