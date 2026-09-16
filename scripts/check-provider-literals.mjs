#!/usr/bin/env node
// Refuse an integration provider's name written outside the places that own it.
//
// ISS-1071's first rule: ONE declaration describes a provider, and every generic
// path resolves what it needs from the registry rather than naming the provider.
// The places allowed to write the name are the provider's own directory, the
// registry and the union beside it, the database schema's vocabulary, the
// contracts enums, and the two identity surfaces where `github` and `google`
// mean a LOGIN provider — a different namespace that happens to share a word.
//
// Every other `provider === 'coolify'` is the same defect: adding a provider
// means editing it, and forgetting it is silent, because the generic path keeps
// answering correctly for the providers it already knows.
//
// What the rule matches, what it deliberately does not, and what that costs:
// `scripts/lib/provider-literals.mjs`.
//
// Modes: --all (CI, the only mode — the rule is repo-wide and a staged subset
// would report clean on a tree that is not)
// Exit: 0 clean · 1 a provider is named outside its declared locations · 2 could not run.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMode, readManifest } from './lib/debt-ratchet.mjs';
import { allowedFaults, byFile, coverageFaults, scanEntries } from './lib/provider-literals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_PATH = 'packages/core/src/integrations/types.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.next', '.turbo']);

function die(message) {
  console.error(`check-provider-literals: ${message}`);
  process.exit(2);
}

// cm:edge naming -> packages/core/src/integrations/types.ts — reads the `INTEGRATION_PROVIDERS`
// array by name. It is read rather than restated so a provider added there cannot leave this scan
// by being forgotten here; a rename of that constant takes the checker to exit 2, which is the
// loud half of the same guarantee.
/** Every provider name the code itself declares. */
function declaredProviders() {
  const path = join(ROOT, TYPES_PATH);
  if (!existsSync(path)) return { error: `${TYPES_PATH} not found — nothing declares the set` };
  const text = readFileSync(path, 'utf8');
  const block = /export const INTEGRATION_PROVIDERS\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!block) return { error: `${TYPES_PATH} declares no INTEGRATION_PROVIDERS array` };
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) return { error: `INTEGRATION_PROVIDERS in ${TYPES_PATH} is empty` };
  return { names };
}

function walk(rel, acc, exts) {
  for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, acc, exts);
      continue;
    }
    // cm:guard test files are out of scope and that is not laziness: a test PROVING the registry
    // answers for `coolify` must write `coolify`, so the rule would forbid the evidence for itself.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (/\.fixture\.tsx?$/.test(entry.name)) continue;
    if (exts.some((ext) => entry.name.endsWith(ext))) acc.push(path);
  }
  return acc;
}

const parsed = parseMode(process.argv, ['--all'], 'check-provider-literals.mjs');
if (parsed.error) die(parsed.error);

const { manifest, error } = readManifest(ROOT);
if (error) die(error);

const cfg = manifest?.checkers?.['provider-literals'];
if (!cfg) die('.forge/conformance.json declares no checkers["provider-literals"] block');

const scanRoots = cfg.scanRoots ?? [];
const scanExts = cfg.scanExts ?? ['.ts', '.tsx'];
if (!Array.isArray(scanRoots) || scanRoots.length === 0) {
  die('checkers["provider-literals"].scanRoots is empty — nothing would be measured');
}

const declared = declaredProviders();
if (declared.error) die(declared.error);

const configFaults = [
  ...allowedFaults(cfg.allowed),
  ...coverageFaults(declared.names, cfg.providers, cfg.unscannable),
];
if (configFaults.length > 0) {
  console.error(
    `check-provider-literals: ${configFaults.length} fault(s) in ` +
      '.forge/conformance.json → checkers["provider-literals"]:\n',
  );
  for (const fault of configFaults) console.error(`  ${fault}`);
  console.error(
    '\nAn allowed location is a rule switched off for a subtree, so it carries the reason\n' +
      "it is correct there — that is this issue's own acceptance criterion, and a line\n" +
      'nobody can read the reason for is a line nobody can retire. Exit 2: the checker\n' +
      'cannot vouch for a scope it cannot read.\n',
  );
  process.exit(2);
}

const files = [];
for (const root of scanRoots) {
  if (!existsSync(join(ROOT, root))) die(`scan root missing: ${root}`);
  walk(root, files, scanExts);
}

const entries = files.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
const { scanned, offenders } = scanEntries(entries, {
  providers: cfg.providers,
  allowed: cfg.allowed,
});

// cm:guard zero files scanned is exit 2 and never exit 0. A scan root that moved, a `scanExts`
// typo and a genuinely clean repo all print the same "no offenders"; only the count separates
// them, which is the fail-closed contract `verify.mjs` parses this line for.
if (scanned === 0) {
  die(`scanned 0 files under ${scanRoots.join(', ')} — the scope matched nothing`);
}

// cm:guard printed on EVERY run, clean or not. `agent` is out of the scanned set by a declared
// decision, and a decision visible only in a JSON file is one the next reader of a green report
// has no way to know was taken.
for (const excused of cfg.unscannable ?? []) {
  console.log(`provider-literals: not scanned — ${excused.provider}: ${excused.why}`);
}

console.log(`provider-literals: ${scanned} file(s) scanned`);
if (offenders.length === 0) process.exit(0);

const grouped = byFile(offenders);
console.error(
  `\ncheck-provider-literals: ${grouped.length} file(s) name a provider outside the ` +
    `${cfg.allowed.length} declared allowed locations\n`,
);
for (const { path, providers, lines } of grouped) {
  console.error(`  ${path}`);
  console.error(
    `    ${providers.join(', ')}  (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')})`,
  );
}
console.error(
  `\n${offenders.length} literal(s) across ${grouped.length} file(s).\n` +
    '\n' +
    'Each of these is a place that must be edited when a provider is added, and that\n' +
    'stays silently correct for the providers it already lists when it is not. Ask the\n' +
    'registry instead — `getIntegration`, `listIntegrations`, `providerCanDeploy`,\n' +
    '`directMcpIntegrations` and `mcpServerNameFor` in\n' +
    'packages/core/src/integrations/registry.ts answer without naming anyone.\n' +
    '\n' +
    "Where the name genuinely belongs — the provider's own directory, the registry, the\n" +
    'schema vocabulary, a contracts enum — add the location to\n' +
    '.forge/conformance.json → checkers["provider-literals"].allowed WITH the sentence\n' +
    'saying what makes it correct there. An entry with no reason is refused.\n',
);
process.exit(1);
